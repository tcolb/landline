//! Chat view of a session: a semantic message log tailed from the
//! harness's own live session file (the "hybrid" interface — see
//! docs/DESIGN.md § Session interfaces).
//!
//! The chat log is the VT screen's semantic sibling: server-side state,
//! snapshot on attach, deltas after. The tailer binds to the newest
//! session file the harness creates after spawn, then follows appends.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use landline_proto::wire::SessionStatus;

use crate::session::Session;

/// Where a chat format writes its live session files for a given cwd.
fn transcript_dir(format: &str, cwd: &Path) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let slug: String = cwd
        .display()
        .to_string()
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    match format {
        "claude" => Some(PathBuf::from(home).join(".claude/projects").join(slug)),
        "pi" => Some(
            PathBuf::from(home)
                .join(".pi/agent/sessions")
                .join(format!("-{slug}-")),
        ),
        _ => None,
    }
}

/// All .jsonl session files currently in `dir`.
fn session_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect()
}

/// Parse one transcript line into zero or more chat items (claude format;
/// pi is best-effort until its shape is pinned down against real files).
fn parse_line(format: &str, line: &str) -> Vec<(String, String, String, Option<String>)> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    match format {
        "claude" => parse_claude(&v),
        "pi" => parse_pi(&v),
        _ => Vec::new(),
    }
}

fn parse_claude(v: &serde_json::Value) -> Vec<(String, String, String, Option<String>)> {
    let mut out = Vec::new();
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if kind != "user" && kind != "assistant" {
        return out;
    }
    let Some(message) = v.get("message") else {
        return out;
    };
    match message.get("content") {
        Some(serde_json::Value::String(text)) => {
            out.push((kind.to_string(), "text".into(), text.clone(), None));
        }
        Some(serde_json::Value::Array(parts)) => {
            for part in parts {
                match part.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        let text = part.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            out.push((kind.to_string(), "text".into(), text.to_string(), None));
                        }
                    }
                    Some("tool_use") => {
                        let tool = part.get("name").and_then(|n| n.as_str()).map(String::from);
                        let input = part.get("input").map(|i| i.to_string()).unwrap_or_default();
                        out.push(("assistant".into(), "tool_use".into(), input, tool));
                    }
                    Some("tool_result") => {
                        let text = match part.get("content") {
                            Some(serde_json::Value::String(s)) => s.clone(),
                            Some(other) => other.to_string(),
                            None => String::new(),
                        };
                        out.push(("tool".into(), "tool_result".into(), text, None));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

fn parse_pi(v: &serde_json::Value) -> Vec<(String, String, String, Option<String>)> {
    // Best-effort: pi's SessionMessageEntry carries a message with
    // role/content; anything else is skipped until validated on real files.
    let Some(message) = v.get("message") else {
        return Vec::new();
    };
    let role = message
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or("system");
    let text = match message.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => return Vec::new(),
    };
    vec![(role.to_string(), "text".into(), text, None)]
}

/// Follow the session's transcript for its lifetime, appending chat items
/// and broadcasting deltas. Binding may take a while — the harness only
/// creates its file on first activity.
pub fn run_tailer(session: Arc<Session>, format: String, cwd: PathBuf) {
    let Some(dir) = transcript_dir(&format, &cwd) else {
        tracing::warn!("unknown chat format '{format}'");
        return;
    };
    // Bind only to a file that did not exist before spawn: mtime
    // heuristics mis-bind to sibling sessions sharing the project dir
    // (e.g. another live session in the same repo).
    let preexisting: std::collections::HashSet<PathBuf> = session_files(&dir).into_iter().collect();
    let path = loop {
        if let Some(p) = session_files(&dir)
            .into_iter()
            .find(|p| !preexisting.contains(p))
        {
            break p;
        }
        if session.status() != SessionStatus::Running {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    tracing::info!("chat tailer bound to {}", path.display());

    let mut offset: u64 = 0;
    let mut carry = String::new();
    loop {
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if len > offset
            && let Ok(bytes) = read_range(&path, offset, len)
        {
            offset = len;
            carry.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(nl) = carry.find('\n') {
                let line: String = carry.drain(..=nl).collect();
                for (role, kind, text, tool) in parse_line(&format, line.trim()) {
                    session.push_chat_item(role, kind, text, tool);
                }
            }
        }
        if session.status() != SessionStatus::Running {
            return; // final read above already drained anything pending
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn read_range(path: &Path, from: u64, to: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(from))?;
    let mut buf = vec![0u8; (to - from) as usize];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_lines_parse_to_items() {
        let user = r#"{"type":"user","message":{"role":"user","content":"hi there"}}"#;
        let asst = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#;
        let result = r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"file.txt"}]}}"#;
        let skip = r#"{"type":"file-history-snapshot","data":{}}"#;
        assert_eq!(
            parse_line("claude", user),
            vec![("user".into(), "text".into(), "hi there".into(), None)]
        );
        let items = parse_line("claude", asst);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].2, "hello");
        assert_eq!(items[1].3.as_deref(), Some("Bash"));
        assert_eq!(parse_line("claude", result)[0].1, "tool_result");
        assert!(parse_line("claude", skip).is_empty());
    }

    #[test]
    fn transcript_dir_slugs_cwd() {
        let d = transcript_dir("claude", Path::new("/home/x/proj.rs")).unwrap();
        assert!(d.ends_with(".claude/projects/-home-x-proj-rs"), "{d:?}");
    }
}
