// Wire protocol types — hand-mirrored from crates/proto/src/wire.rs.
// The contract is docs/PROTOCOL.md; keep this file in sync with it.

export const PROTOCOL_VERSION = 1;

export const FLAG_BOLD = 1;
export const FLAG_ITALIC = 2;
export const FLAG_UNDERLINE = 4;
export const FLAG_INVERSE = 8;
export const FLAG_FAINT = 16;
export const FLAG_STRIKETHROUGH = 32;
export const FLAG_WIDE_SPACER = 64;

export interface CellData {
  t: string;
  fg: [number, number, number] | null;
  bg: [number, number, number] | null;
  fl: number;
}

export interface RowData {
  y: number;
  cells: CellData[];
}

export interface Cursor {
  x: number;
  y: number;
  visible: boolean;
}

export type Frame =
  | {
      kind: "snapshot";
      rows: number;
      cols: number;
      lines: RowData[];
      cursor: Cursor;
      /** Mouse tracking active in the session (swipe → wheel codes). */
      mouse?: boolean;
      /** Highest input seq written to the PTY before this frame. */
      ack?: number;
    }
  | { kind: "diff"; lines: RowData[]; cursor: Cursor; mouse?: boolean; ack?: number };

export type SessionStatus =
  | { state: "running" }
  | { state: "exited"; code: number | null };

export interface SessionInfo {
  id: string;
  name: string;
  cmd: string[];
  cwd: string;
  environment: string;
  rows: number;
  cols: number;
  status: SessionStatus;
}

export interface SpawnRequest {
  template: string | null;
  params: Record<string, string>;
  name: string | null;
  cmd: string[] | null;
  cwd: string | null;
  env: string | null;
  image: string | null;
  rows: number;
  cols: number;
}

/** A spawnable template (agent-first: the primary spawn surface). */
export interface TemplateInfo {
  name: string;
  description?: string;
  params: TemplateParam[];
  environment: string;
  command: string;
}

/** A selectable environment — the overridable second spawn dimension. */
export interface EnvironmentInfo {
  name: string;
  description?: string;
  kind: string;
  image?: string;
}

export interface TemplateParam {
  name: string;
  default?: string;
  required: boolean;
}

export interface SessionEvent {
  kind: "created" | "exited";
  info: SessionInfo;
}

export type Request =
  | { type: "hello"; version: number }
  | { type: "spawn"; spawn: SpawnRequest }
  | { type: "ls" }
  | { type: "kill"; session: string }
  | { type: "attach"; session: string; mode: "frames" | "bytes" }
  | { type: "watch" }
  | { type: "input"; data: string; seq?: number } // base64
  | { type: "resize"; rows: number; cols: number }
  | { type: "detach" }
  | { type: "stats"; session: string }
  | { type: "templates"; cwd?: string }
  | { type: "environments"; cwd?: string };

export type Response =
  | { type: "ok" }
  | { type: "error"; message: string }
  | { type: "hello"; version: number; features: string[] }
  | { type: "spawned"; info: SessionInfo }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "frame"; frame: Frame }
  | { type: "bytes"; data: string } // base64
  | { type: "event"; event: SessionEvent }
  | { type: "stats"; stats: Record<string, unknown> }
  | { type: "templates"; templates: TemplateInfo[] }
  | { type: "environments"; environments: EnvironmentInfo[] }
  | { type: "exited"; code: number | null };

// Base64 helpers, dependency-free (Hermes has atob/btoa, but UTF-8 needs
// byte-level handling either way).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

export function utf8ToBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000)
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return Uint8Array.from(out);
}

export function inputMessage(text: string, seq?: number): Request {
  return { type: "input", data: bytesToB64(utf8ToBytes(text)), seq };
}
