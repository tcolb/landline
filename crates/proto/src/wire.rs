//! Wire protocol between clients and `landlined`.
//!
//! Transports: newline-delimited JSON over the unix socket; one JSON message
//! per text frame over WebSocket. The message set is identical on both.
//! Binary payloads (`input`, `bytes`) are base64 strings. The full contract
//! lives in `docs/PROTOCOL.md`; keep these types transport-agnostic.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// Feature names reported in [`Response::Hello`].
pub const FEATURES: &[&str] = &[
    "frames",
    "bytes",
    "watch",
    "templates",
    "template-list",
    "environment-list",
    "chat",
    "stats",
    "input-seq",
    "chat-actions",
    "chat-status",
];

/// Base64 (standard alphabet, padded) serde adapter for binary payloads.
pub mod b64 {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(data: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(data))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD.decode(s).map_err(serde::de::Error::custom)
    }
}

/// Cell attribute bits in [`CellData::flags`].
pub mod cellflags {
    pub const BOLD: u8 = 1 << 0;
    pub const ITALIC: u8 = 1 << 1;
    pub const UNDERLINE: u8 = 1 << 2;
    pub const INVERSE: u8 = 1 << 3;
    pub const FAINT: u8 = 1 << 4;
    pub const STRIKETHROUGH: u8 = 1 << 5;
    /// Continuation cell of a wide grapheme; carries no text of its own.
    pub const WIDE_SPACER: u8 = 1 << 6;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub cmd: Vec<String>,
    pub cwd: String,
    /// Environment the session runs in, e.g. "host" or "container:ubuntu".
    pub environment: String,
    pub rows: u16,
    pub cols: u16,
    pub status: SessionStatus,
    /// Whether a chat view is available (harness has a chat mirror).
    #[serde(default)]
    pub chat: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SessionStatus {
    Running,
    Exited { code: Option<i32> },
}

/// What to spawn. Either references a template (resolved daemon-side against
/// the registries, with `params` filled in) or carries an inline command.
/// Inline fields also act as overrides on top of a template.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpawnRequest {
    pub template: Option<String>,
    #[serde(default)]
    pub params: HashMap<String, String>,
    pub name: Option<String>,
    pub cmd: Option<Vec<String>>,
    pub cwd: Option<String>,
    /// Named environment spec from the registry.
    pub env: Option<String>,
    /// Shorthand: container environment with this image (auto runtime).
    pub image: Option<String>,
    pub rows: u16,
    pub cols: u16,
}

/// How an attached client wants session output delivered.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachMode {
    /// Server-rendered snapshot + dirty-row diffs ([`Frame`]s). For thin
    /// clients that paint cells and bring no emulator.
    #[default]
    Frames,
    /// Raw PTY passthrough ([`Response::Bytes`]), preceded by a
    /// VT-reconstruction snapshot of the current screen. For clients with
    /// their own terminal emulator — tmux-attach semantics.
    Bytes,
    /// Semantic message log (chat view). Available when the session's
    /// harness provides a chat mirror; a live projection of the same
    /// process the terminal modes show.
    Chat,
}

/// Client → daemon. `Input`/`Resize`/`Detach` are only valid after `Attach`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// Optional version/capability negotiation; valid as any message, but
    /// conventionally first.
    Hello {
        version: u32,
    },
    Spawn {
        spawn: SpawnRequest,
    },
    Ls,
    Kill {
        session: String,
    },
    Attach {
        session: String,
        #[serde(default)]
        mode: AttachMode,
    },
    /// Subscribe to session lifecycle events for the rest of the connection.
    Watch,
    Input {
        #[serde(with = "b64")]
        data: Vec<u8>,
        /// Client-monotonic sequence number; echoed back as frame `ack`
        /// so clients can measure true input→effect latency on one clock.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
    },
    Resize {
        rows: u16,
        cols: u16,
    },
    Detach,
    /// Per-session pipeline statistics (docs/PROFILING.md).
    Stats {
        session: String,
    },
    /// List spawnable templates. `cwd` scopes in project-local templates
    /// (`.landline/templates/`), which shadow user-level ones.
    Templates {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// List selectable environments (the overridable second dimension of a
    /// spawn: agent × environment).
    Environments {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
}

/// Daemon → client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Ok,
    Error {
        message: String,
    },
    Hello {
        version: u32,
        features: Vec<String>,
    },
    Spawned {
        info: SessionInfo,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    Frame {
        frame: Frame,
    },
    /// Raw PTY output; only in `bytes` attach mode.
    Bytes {
        #[serde(with = "b64")]
        data: Vec<u8>,
    },
    /// Session lifecycle event; only after `Watch`.
    Event {
        event: SessionEvent,
    },
    /// Full message log on chat attach; fully replaces client state.
    ChatSnapshot {
        items: Vec<ChatItem>,
    },
    /// One appended message; only in `chat` attach mode.
    ChatItem {
        item: ChatItem,
    },
    /// Busy-state transition; only in `chat` attach mode. Derived from PTY
    /// output activity — fires before any transcript write, so "working"
    /// shows from the moment the agent starts streaming.
    ChatStatus {
        working: bool,
    },
    /// Reply to `Stats`: counters and histograms, shape documented in
    /// docs/PROFILING.md. Schemaless on purpose — additive by nature.
    Stats {
        stats: serde_json::Value,
    },
    /// Reply to `Templates`.
    Templates {
        templates: Vec<TemplateInfo>,
    },
    /// Reply to `Environments`.
    Environments {
        environments: Vec<EnvironmentInfo>,
    },
    Exited {
        code: Option<i32>,
    },
}

/// A spawnable template, as shown in pickers. Templates are the primary
/// spawn surface (agent-first design); resolution stays daemon-side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub params: Vec<TemplateParam>,
    /// Environment summary, e.g. "host", "container:ubuntu", "env:gpu-box".
    pub environment: String,
    /// Harness summary, e.g. "claude" or "use:claude-profile".
    pub command: String,
}

/// A selectable environment. "host" is always present.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// "host" | "container".
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateParam {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default)]
    pub required: bool,
}

/// One entry in a session's chat view. `id` is monotonic per session;
/// clients dedupe deltas against the snapshot with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatItem {
    pub id: u64,
    /// "user" | "assistant" | "tool" | "system".
    pub role: String,
    /// "text" | "thinking" | "action" | "action_result" | "event".
    pub kind: String,
    pub text: String,
    /// Raw harness tool name for action items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Semantic action class: "command" | "file_edit" | "file_read" |
    /// "search" | "subagent" | "web" | "other".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Short human line for the action ("Edit src/main.rs").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The action's primary object: file path, command, url, agent type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Harness call id linking an action_result to its action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// For action_result: false when the harness marked the call failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    /// True when `text` was capped server-side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    /// Set on items produced by a subagent: the `call_id` of the action
    /// that spawned it (nest under that chip).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub kind: SessionEventKind,
    pub info: SessionInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEventKind {
    Created,
    Exited,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellData {
    /// Full grapheme cluster as UTF-8. Empty for blank and spacer cells.
    pub t: String,
    /// Foreground RGB, if the cell sets one.
    pub fg: Option<[u8; 3]>,
    /// Background RGB, if the cell sets one.
    pub bg: Option<[u8; 3]>,
    /// Bitmask of [`cellflags`].
    pub fl: u8,
}

/// One row of cells. `cells[i]` is column `i`; wide graphemes occupy their
/// base cell plus `WIDE_SPACER` continuation cells, so indices stay columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowData {
    pub y: u16,
    pub cells: Vec<CellData>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
}

/// Screen content pushed to attached clients. A `Snapshot` fully replaces
/// client state; a `Diff` carries only rows that changed since the last frame.
/// `mouse` reports whether the session has mouse tracking enabled, so
/// clients can translate scroll gestures into wheel events vs arrow keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Frame {
    Snapshot {
        rows: u16,
        cols: u16,
        lines: Vec<RowData>,
        cursor: Cursor,
        #[serde(default)]
        mouse: bool,
        /// Highest input `seq` written to the PTY before this frame was
        /// generated (an upper-bound correlation, mosh-style).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ack: Option<u64>,
    },
    Diff {
        lines: Vec<RowData>,
        cursor: Cursor,
        #[serde(default)]
        mouse: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ack: Option<u64>,
    },
}
