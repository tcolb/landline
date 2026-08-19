//! Chat view of a session: a semantic message log tailed from the
//! harness's own live session file (the "hybrid" interface — see
//! docs/DESIGN.md § Session interfaces).
//!
//! The chat log is the VT screen's semantic sibling: server-side state,
//! snapshot on attach, deltas after. The tailer binds to the newest
//! session file the harness creates after spawn, then follows appends.
//! What each line MEANS is delegated to the harness descriptor
//! (crate::harness): parser families here, classification rules there.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use landline_proto::wire::SessionStatus;

use crate::harness::HarnessSpec;
use crate::session::{NewChatItem, Session};

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

/// Parse one transcript line into zero or more chat items, per the spec's
/// parser family, classifying tool calls through its rule table.
fn parse_line(spec: &HarnessSpec, line: &str) -> Vec<NewChatItem> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    match spec.transcript.format.as_str() {
        "claude-jsonl" => parse_claude(spec, &v),
        "pi-jsonl" => parse_pi(&v),
        other => {
            tracing::warn!("unknown parser family '{other}'");
            Vec::new()
        }
    }
}

fn text_item(role: &str, kind: &str, text: String) -> NewChatItem {
    NewChatItem {
        role: role.into(),
        kind: kind.into(),
        text,
        ..NewChatItem::default()
    }
}

fn parse_claude(spec: &HarnessSpec, v: &serde_json::Value) -> Vec<NewChatItem> {
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
            out.push(text_item(kind, "text", text.clone()));
        }
        Some(serde_json::Value::Array(parts)) => {
            for part in parts {
                match part.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        let text = part.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            out.push(text_item(kind, "text", text.to_string()));
                        }
                    }
                    Some("thinking") => {
                        let text = part.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            out.push(text_item("assistant", "thinking", text.to_string()));
                        }
                    }
                    Some("tool_use") => {
                        let tool = part.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        let empty = serde_json::json!({});
                        let input = part.get("input").unwrap_or(&empty);
                        let classified = spec.classify(tool, input);
                        out.push(NewChatItem {
                            role: "assistant".into(),
                            kind: "action".into(),
                            text: input.to_string(),
                            tool: Some(tool.to_string()),
                            category: Some(classified.category),
                            title: Some(classified.title),
                            target: classified.target,
                            call_id: part
                                .get("id")
                                .and_then(|i| i.as_str())
                                .map(String::from),
                        });
                    }
                    Some("tool_result") => {
                        let text = match part.get("content") {
                            Some(serde_json::Value::String(s)) => s.clone(),
                            Some(other) => other.to_string(),
                            None => String::new(),
                        };
                        out.push(NewChatItem {
                            role: "tool".into(),
                            kind: "action_result".into(),
                            text,
                            call_id: part
                                .get("tool_use_id")
                                .and_then(|i| i.as_str())
                                .map(String::from),
                            ..NewChatItem::default()
                        });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

fn parse_pi(v: &serde_json::Value) -> Vec<NewChatItem> {
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
    vec![text_item(role, "text", text)]
}

/// Follow the session's transcript for its lifetime, appending chat items
/// and broadcasting deltas. Binding may take a while — the harness only
/// creates its file on first activity.
pub fn run_tailer(session: Arc<Session>, harness: String, cwd: PathBuf) {
    let Some(spec) = crate::harness::find(&harness) else {
        tracing::warn!("unknown chat harness '{harness}'");
        return;
    };
    let dir = spec.transcript_dir(&cwd);
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
                for item in parse_line(&spec, line.trim()) {
                    session.push_chat_item(item);
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

    fn spec() -> HarnessSpec {
        crate::harness::find("claude").unwrap()
    }

    #[test]
    fn claude_lines_parse_to_items() {
        let user = r#"{"type":"user","message":{"role":"user","content":"hi there"}}"#;
        let asst = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#;
        let result = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"file.txt"}]}}"#;
        let skip = r#"{"type":"file-history-snapshot","data":{}}"#;
        let items = parse_line(&spec(), user);
        assert_eq!(items.len(), 1);
        assert_eq!((items[0].role.as_str(), items[0].kind.as_str()), ("user", "text"));

        let items = parse_line(&spec(), asst);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "hello");
        assert_eq!(items[1].kind, "action");
        assert_eq!(items[1].tool.as_deref(), Some("Bash"));
        assert_eq!(items[1].category.as_deref(), Some("command"));
        assert_eq!(items[1].title.as_deref(), Some("Run ls"));
        assert_eq!(items[1].call_id.as_deref(), Some("t1"));

        let items = parse_line(&spec(), result);
        assert_eq!(items[0].kind, "action_result");
        assert_eq!(items[0].call_id.as_deref(), Some("t1"));
        assert!(parse_line(&spec(), skip).is_empty());
    }

    #[test]
    fn thinking_blocks_surface() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"pondering..."}]}}"#;
        let items = parse_line(&spec(), line);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "thinking");
        assert_eq!(items[0].text, "pondering...");
    }
}
