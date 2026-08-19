//! Harness adapters: how a given agent harness's live session becomes the
//! chat view (docs/DESIGN.md § Harness adapters).
//!
//! Split by what changes per harness:
//! - Parser FAMILIES are code ("claude-jsonl", "pi-jsonl") — the structural
//!   shape of a transcript line.
//! - Everything else is DATA: a descriptor naming the transcript location
//!   and a rule table classifying raw tool calls into semantic actions
//!   (command / file_edit / subagent / ...). Built-in descriptors ship
//!   compiled in; `~/.config/landline/harnesses/<name>.toml` adds new
//!   harnesses or shadows the built-ins without touching Rust.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// One harness descriptor: transcript location + action classification.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HarnessSpec {
    pub name: String,
    pub transcript: TranscriptSpec,
    /// First matching rule wins; unmatched tools classify as "other".
    #[serde(default, rename = "action")]
    pub actions: Vec<ActionRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptSpec {
    /// Parser family: "claude-jsonl" | "pi-jsonl".
    pub format: String,
    /// Directory template. `{home}` and `{cwd_slug}` (cwd with `/` and `.`
    /// mapped to `-`) are substituted.
    pub dir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionRule {
    /// Raw tool name to match (exact).
    pub tool: String,
    /// Semantic class: "command" | "file_edit" | "file_read" | "search" |
    /// "subagent" | "web" | "other".
    pub category: String,
    /// Title template; `{input.<field>}` substitutes from the tool input
    /// object, with an optional `:<maxlen>` truncation — e.g.
    /// `"Run {input.command:60}"`.
    pub title: String,
    /// Input field holding the action's primary object (dotted path).
    #[serde(default)]
    pub target: Option<String>,
}

/// A classified action ready to become a ChatItem.
pub struct Classified {
    pub category: String,
    pub title: String,
    pub target: Option<String>,
}

impl HarnessSpec {
    pub fn transcript_dir(&self, cwd: &Path) -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_default();
        let slug: String = cwd
            .display()
            .to_string()
            .chars()
            .map(|c| if c == '/' || c == '.' { '-' } else { c })
            .collect();
        PathBuf::from(
            self.transcript
                .dir
                .replace("{home}", &home)
                .replace("{cwd_slug}", &slug),
        )
    }

    /// Classify a raw tool call against the rule table.
    pub fn classify(&self, tool: &str, input: &serde_json::Value) -> Classified {
        for rule in &self.actions {
            if rule.tool == tool {
                return Classified {
                    category: rule.category.clone(),
                    title: render_template(&rule.title, input),
                    target: rule
                        .target
                        .as_deref()
                        .and_then(|path| lookup(input, path.strip_prefix("input.").unwrap_or(path)))
                        .map(json_to_text),
                };
            }
        }
        Classified {
            category: "other".into(),
            title: tool.to_string(),
            target: None,
        }
    }
}

/// `{input.<dotted.path>[:maxlen]}` substitution.
fn render_template(template: &str, input: &serde_json::Value) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let expr = &rest[start + 1..start + end];
        rest = &rest[start + end + 1..];
        let (path, maxlen) = match expr.rsplit_once(':') {
            Some((p, n)) if n.chars().all(|c| c.is_ascii_digit()) => {
                (p, n.parse::<usize>().ok())
            }
            _ => (expr, None),
        };
        let value = lookup(input, path.strip_prefix("input.").unwrap_or(path))
            .map(json_to_text)
            .unwrap_or_default();
        let mut value = value.replace('\n', " ");
        if let Some(n) = maxlen
            && value.chars().count() > n
        {
            value = value.chars().take(n).collect::<String>() + "…";
        }
        out.push_str(&value);
    }
    out.push_str(rest);
    out
}

fn lookup<'a>(v: &'a serde_json::Value, dotted: &str) -> Option<&'a serde_json::Value> {
    dotted.split('.').try_fold(v, |acc, key| acc.get(key))
}

fn json_to_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Built-in descriptors, shadowable by user TOML of the same name.
fn builtin_specs() -> Vec<HarnessSpec> {
    let claude = r#"
name = "claude"
[transcript]
format = "claude-jsonl"
dir = "{home}/.claude/projects/{cwd_slug}"

[[action]]
tool = "Bash"
category = "command"
title = "Run {input.command:60}"
target = "input.command"

[[action]]
tool = "Edit"
category = "file_edit"
title = "Edit {input.file_path}"
target = "input.file_path"

[[action]]
tool = "Write"
category = "file_edit"
title = "Write {input.file_path}"
target = "input.file_path"

[[action]]
tool = "NotebookEdit"
category = "file_edit"
title = "Edit {input.notebook_path}"
target = "input.notebook_path"

[[action]]
tool = "Read"
category = "file_read"
title = "Read {input.file_path}"
target = "input.file_path"

[[action]]
tool = "Glob"
category = "search"
title = "Glob {input.pattern:60}"
target = "input.pattern"

[[action]]
tool = "Grep"
category = "search"
title = "Grep {input.pattern:60}"
target = "input.pattern"

[[action]]
tool = "Task"
category = "subagent"
title = "Agent: {input.description:60}"
target = "input.subagent_type"

[[action]]
tool = "WebFetch"
category = "web"
title = "Fetch {input.url:60}"
target = "input.url"

[[action]]
tool = "WebSearch"
category = "web"
title = "Search {input.query:60}"
target = "input.query"
"#;
    let pi = r#"
name = "pi"
[transcript]
format = "pi-jsonl"
dir = "{home}/.pi/agent/sessions/-{cwd_slug}-"

[[action]]
tool = "bash"
category = "command"
title = "Run {input.command:60}"
target = "input.command"

[[action]]
tool = "edit"
category = "file_edit"
title = "Edit {input.path}"
target = "input.path"

[[action]]
tool = "write"
category = "file_edit"
title = "Write {input.path}"
target = "input.path"

[[action]]
tool = "read"
category = "file_read"
title = "Read {input.path}"
target = "input.path"
"#;
    [claude, pi]
        .iter()
        .map(|t| toml::from_str(t).expect("builtin harness spec"))
        .collect()
}

fn user_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".config/landline/harnesses"))
}

/// Resolve a harness by name: user descriptor shadows built-in.
pub fn find(name: &str) -> Option<HarnessSpec> {
    if let Some(dir) = user_dir() {
        let path = dir.join(format!("{name}.toml"));
        if let Ok(text) = std::fs::read_to_string(&path) {
            match toml::from_str::<HarnessSpec>(&text) {
                Ok(spec) => return Some(spec),
                Err(e) => tracing::warn!("skipping unparseable {}: {e}", path.display()),
            }
        }
    }
    builtin_specs().into_iter().find(|s| s.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_claude_tools() {
        let spec = find("claude").unwrap();
        let c = spec.classify("Bash", &serde_json::json!({"command": "cargo test"}));
        assert_eq!(c.category, "command");
        assert_eq!(c.title, "Run cargo test");
        assert_eq!(c.target.as_deref(), Some("cargo test"));

        let c = spec.classify("Task", &serde_json::json!({"description": "scan", "subagent_type": "Explore"}));
        assert_eq!(c.category, "subagent");
        assert_eq!(c.target.as_deref(), Some("Explore"));

        let c = spec.classify("Mystery", &serde_json::json!({}));
        assert_eq!(c.category, "other");
        assert_eq!(c.title, "Mystery");
    }

    #[test]
    fn template_truncation() {
        let long = "x".repeat(100);
        let out = render_template("Run {input.command:10}", &serde_json::json!({"command": long}));
        assert_eq!(out, format!("Run {}…", "x".repeat(10)));
    }

    #[test]
    fn transcript_dir_substitution() {
        let spec = find("claude").unwrap();
        let d = spec.transcript_dir(Path::new("/home/x/proj.rs"));
        assert!(d.ends_with(".claude/projects/-home-x-proj-rs"), "{d:?}");
    }
}
