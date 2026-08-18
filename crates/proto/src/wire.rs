//! Wire protocol between clients and `landlined`.
//!
//! M1 transport: newline-delimited JSON over a unix socket. The same message
//! set is reused over WebSocket in later milestones; frame encoding may move
//! to a binary format then, so keep these types transport-agnostic.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

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

/// Client → daemon. `Input`/`Resize`/`Detach` are only valid after `Attach`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Spawn { spawn: SpawnRequest },
    Ls,
    Kill { session: String },
    Attach { session: String },
    Input { data: Vec<u8> },
    Resize { rows: u16, cols: u16 },
    Detach,
}

/// Daemon → client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Ok,
    Error { message: String },
    Spawned { info: SessionInfo },
    Sessions { sessions: Vec<SessionInfo> },
    Frame { frame: Frame },
    Exited { code: Option<i32> },
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Cursor {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
}

/// Screen content pushed to attached clients. A `Snapshot` fully replaces
/// client state; a `Diff` carries only rows that changed since the last frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Frame {
    Snapshot {
        rows: u16,
        cols: u16,
        lines: Vec<RowData>,
        cursor: Cursor,
    },
    Diff {
        lines: Vec<RowData>,
        cursor: Cursor,
    },
}
