# landline protocol

Version: **1**. The protocol between any client and `landlined`. It is the
product boundary: everything the CLI, the mobile app, dashboards, and
third-party frontends can do goes through these messages. Plain JSON — no
client needs code from this repo.

## Transports

Both transports carry the identical message set:

- **Unix socket** — newline-delimited JSON. One message per line. Socket at
  `$XDG_RUNTIME_DIR/landline.sock` (fallback `/tmp/landline-<uid>.sock`).
- **WebSocket** — one JSON message per text frame. Served when the daemon
  runs with `--ws ADDR`; connect to `ws://ADDR/ws?token=<token>`, where
  `<token>` is the contents of `~/.local/share/landline/ws-token` (generated
  0600 on first start). This is bearer-token access for LAN/tunnel use;
  real pairing and E2E encryption arrive with the relay (M5).

Binary payloads (`input`, `bytes`) are base64 strings (standard alphabet,
padded).

## Negotiation

Optional but recommended as the first message:

```json
→ {"type": "hello", "version": 1}
← {"type": "hello", "version": 1, "features": ["frames", "bytes", "watch", "templates"]}
```

The server replies with its protocol version and feature list; a client that
needs a missing feature should disconnect with an error to its user. Servers
never change behavior based on the client's stated version within a major
protocol version.

## Message flow

A connection is in one of three states: **control** (initial), **attached**,
or **watching**. `attach` and `watch` are one-way doors: they consume the
rest of the connection. Open one connection per concern.

### Control state

| Request | Response |
|---|---|
| `{"type": "spawn", "spawn": SpawnRequest}` | `spawned` or `error` |
| `{"type": "ls"}` | `sessions` |
| `{"type": "kill", "session": ID_OR_NAME}` | `ok` or `error` |
| `{"type": "attach", "session": ID_OR_NAME, "mode": "frames" \| "bytes" \| "chat"}` | → attached state |
| `{"type": "watch"}` | `ok`, then → watching state |
| `{"type": "stats", "session": ID_OR_NAME}` | `stats` (counters/histograms; see docs/PROFILING.md) |
| `{"type": "templates", "cwd": PATH?}` | `templates` — spawnable templates (name, description, params with defaults/required, environment and harness summaries). `cwd` scopes in project-local `.landline/templates/`, which shadow user-level ones. Templates are the primary spawn surface (agent-first design). |
| `{"type": "environments", "cwd": PATH?}` | `environments` — selectable environments (name, description, kind, image); "host" is always present. Spawning with `env` overrides the template's environment: agent and environment are independent dimensions. |

`SpawnRequest`:

```json
{
  "template": "webapp-fix",          // optional; resolved daemon-side
  "params": {"branch": "main"},      // template parameters
  "name": "fix-login",               // optional; defaults to session id
  "cmd": ["claude"],                 // inline command (overrides template)
  "cwd": "/home/user/project",       // client cwd; workspace root
  "env": "gpu-box",                  // named environment spec, or "host"
  "image": "ubuntu:24.04",           // shorthand: per-session container
  "rows": 24, "cols": 80
}
```

Sessions are addressed by id (`s1`) or name; a name resolves to the running
session bearing it in preference to exited ones.

### Attached state (`mode: "frames"`)

For thin clients that paint cells and bring no emulator (the mobile app).

On attach the server sends a `frame` of kind `snapshot`, then `frame`s of
kind `diff` coalesced on a ~16 ms tick. A snapshot fully replaces client
state; a diff carries only changed rows. If the server ever falls behind a
slow client it resynchronizes by sending a fresh snapshot — clients must
handle a snapshot at any time.

```json
← {"type": "frame", "frame": {
     "kind": "snapshot", "rows": 24, "cols": 80,
     "lines": [{"y": 0, "cells": [{"t": "h", "fg": [255,0,0], "bg": null, "fl": 1}, …]}, …],
     "cursor": {"x": 5, "y": 0, "visible": true}}}
← {"type": "frame", "frame": {"kind": "diff", "lines": […], "cursor": …}}
```

Cell fields: `t` — full grapheme cluster as UTF-8 (empty = blank); `fg`/`bg`
— RGB triples or null for default; `fl` — flag bits: 1 bold, 2 italic,
4 underline, 8 inverse, 16 faint, 32 strikethrough, 64 wide-spacer (a
continuation cell of a wide grapheme; render nothing, the base cell spans).

Frames also carry `mouse` (boolean, default false): whether the session has
mouse tracking enabled. Clients use it to translate scroll gestures — SGR
wheel events (`ESC [<64;col;row M` / `65`) when true, arrow keys when
false.

### Attached state (`mode: "bytes"`)

For clients with their own terminal emulator — tmux-attach semantics. This
is what `landline attach --mode bytes` uses, and what makes any terminal
frontend able to host a landline session as an ordinary pane command.

On attach the server sends one `bytes` message containing a
**VT-reconstruction snapshot**: the current screen (content including
scrollback, styles, cursor, terminal modes) serialized as an escape stream
by the server-side emulator. Replaying it into a fresh emulator reproduces
the live screen instantly. After that, raw PTY output streams as further
`bytes` messages. If the server drops output for a slow client, it resyncs
with a fresh reconstruction snapshot.

```json
← {"type": "bytes", "data": "G1sxOzFIG1sybUhlbGxv…"}
```

### Attached state (`mode: "chat"`)

The semantic message log of a hybrid session (DESIGN.md § Session
interfaces) — available when `SessionInfo.chat` is true; attaching a
non-chat session yields an error. On attach the server sends the full
log, then one message per appended item. Item `id` is monotonic per
session; on a lag-resync the server sends a fresh `chat_snapshot`, which
fully replaces client state.

```json
← {"type": "chat_snapshot", "items": [ChatItem, …]}
← {"type": "chat_item", "item": {"id": 7, "role": "assistant",
     "kind": "action", "tool": "Bash", "category": "command",
     "title": "Run ls", "target": "ls", "call_id": "toolu_1",
     "text": "{\"command\":\"ls\"}"}}
```

`role`: user | assistant | tool | system. `kind`: text | thinking |
action | action_result | event. Actions are raw harness tool calls
classified through the session's harness descriptor (DESIGN.md § Harness
adapters): `category` is the semantic class (command | file_edit |
file_read | search | subagent | web | other), `title` a short human line,
`target` the primary object (path, command, url, agent type), `call_id`
the harness id linking an `action_result` to its `action`; `text` keeps
the raw input/output. Results also carry `ok` (false when the harness
marked the call failed) and `truncated` (true when `text` was capped
server-side; the terminal view holds full output). A client can derive a
"working" state from any action whose `call_id` has no result yet. All of these fields are optional (feature
`chat-actions`, additive). Input/resize/detach behave exactly as in the
other modes — chat input types into the same PTY the terminal views show.

### Client → server while attached (all modes)

```json
→ {"type": "input", "data": "aGVsbG8=", "seq": 42}  // base64 keyboard bytes
→ {"type": "resize", "rows": 50, "cols": 120}       // last writer wins
→ {"type": "detach"}                                // server closes gracefully
```

`seq` is an optional client-monotonic counter. Frames carry `ack`: the
highest `seq` whose bytes had been written to the session PTY when the
frame was generated. Clients measure input→effect latency on their own
clock as `t_painted(first frame with ack >= s) − t_sent(s)`. The
correlation is an upper bound (a frame generated after the write may
predate the input's visible effect), mosh-style; see docs/PROFILING.md.

When the session's child exits, the server sends any final output, then:

```json
← {"type": "exited", "code": 0}
```

Attaching to an already-exited session yields its retained final screen
(one `frame` or `bytes` message) followed by `exited` — postmortem attach
always shows the last screen.

### Watching state

Session lifecycle events, no terminal streams — the control plane for
orchestrators, dashboards, and frontend adapters:

```json
← {"type": "event", "event": {"kind": "created", "info": SessionInfo}}
← {"type": "event", "event": {"kind": "exited",  "info": SessionInfo}}
```

`SessionInfo`:

```json
{"id": "s1", "name": "fix-login", "cmd": ["claude"], "cwd": "/home/user/p",
 "environment": "container:ubuntu:24.04", "rows": 24, "cols": 80,
 "status": {"state": "running"}}          // or {"state": "exited", "code": 0}
```

Only `detach` is valid from the client while watching.

## Errors

Any request can produce `{"type": "error", "message": "…"}`. Errors do not
close the connection except where noted; a client should treat an error to
`attach`/`spawn` as terminal for that operation, not the connection.

## Hooks (server-side, not wire messages)

The daemon runs user-configured commands on the same lifecycle events
`watch` exposes — `~/.config/landline/config.toml`:

```toml
[hooks]
session_created = "my-adapter add"
session_exited  = "my-adapter remove"
```

Hooks run detached via `sh -c` with `LANDLINE_EVENT`,
`LANDLINE_SESSION_ID`, `LANDLINE_SESSION_NAME`,
`LANDLINE_SESSION_ENVIRONMENT`, `LANDLINE_SESSION_CWD`, and (on exit)
`LANDLINE_EXIT_CODE` in the environment. Together with `bytes`-mode attach
they are the extension points for hosting landline sessions inside other
frontends.

## Compatibility rules

- Additions (new request/response types, new fields) are backward
  compatible within a version; clients must ignore unknown fields and
  tolerate unknown response types.
- Removals or semantic changes bump `version` and are announced in the
  `hello` exchange.
- Binary frame encoding, if ever added, will be negotiated via `hello`
  features; JSON remains the baseline.
