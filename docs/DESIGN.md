# landline — Design

*Status: draft v0.1 — 2026-08-17*

## What it is

An **agent session runtime** with a **native mobile app as a first-class
client**. `landlined` runs on your machine or VPS and owns long-lived agent
sessions (Claude Code, Codex, Gemini CLI, OpenCode, Amp, anything that runs in
a terminal). A session is **environment × harness × interface**: spawning one
provisions an isolated execution environment (host process, Docker container,
later microVM / cloud sandbox), runs the harness in a PTY inside it, and
serves the **real TUI** to any attached client — not a chat-style
interpretation. The iOS/Android app connects directly or through a thin
hosted relay to spawn, watch, drive, and kill sessions. Sessions can message
each other.

## Positioning (2026-08 landscape)

The existing field splits into three shapes, none of which combine landline's
pillars:

- **Terminal-native agent multiplexers** — background server owning PTYs,
  thin TUI clients, agent state awareness, socket APIs for agent-to-agent
  orchestration. Proven runtime shape; no mobile story.
- **Mobile mirrors/orchestrators** — phone apps driving agent sessions
  through an E2E-encrypted relay with device pairing. Proven mobile+relay
  shape, but built on per-provider message adapters rendered as chat: a
  fixed list of supported agents, no faithful TUI, and isolation (where it
  exists at all) is one shared container around the whole daemon rather than
  per session.
- **Desktop agent IDEs** — parallel agents in git worktrees with real
  terminals, but bound to a desktop app; mobile is a companion at best.

Mobile control of agent sessions is table stakes now. The unclaimed ground is
the combination landline is built on:

1. **PTY-native, real TUI** — any terminal program is a session, rendered
   faithfully on the phone. No per-provider adapters, no chat translation.
2. **Per-session environments** — each session gets its own isolation
   boundary (host / container / VM), not one shared boundary around the
   runtime.

Relevant standards to track, not adopt yet: **ACP** (client↔agent
conversation protocol) and **AHP** (multi-client shared-session coordination —
turn arbitration, state sync). Our PTY-level approach is what makes us
harness-agnostic *including TUIs*; an ACP session type can be added later as
an alternative, and AHP informs multi-device attach semantics.

## Core technical bet: server-side terminal emulation

Each session = PTY + a **headless VT screen** maintained in the daemon
(**`libghostty-vt`** — Ghostty's Zig VT core via its C ABI / Rust crate,
production-proven for exactly this server-side use). Clients never parse escape
sequences. libghostty-vt also gives us the **key encoder** (client key events
→ escape sequences, incl. Kitty keyboard protocol) — exactly the hard part of
mobile input — plus reflow-on-resize and WASM support (reusable in the web
debug client). Its API is pre-1.0, so the VT sits behind a small `Screen`
trait in `crates/landlined`; `alacritty_terminal` remains the drop-in
fallback if API churn becomes costly. On attach they
receive a **screen snapshot** (rows × cols of styled cells) and then **dirty-
line diffs**. This is what makes mobile TUI rendering cheap: the app is a dumb
grid painter, reconnects are instant (snapshot, not replay), bandwidth and
battery cost stay low, and scrollback is served on demand.

## Architecture

```
┌─ phone (Expo app) ──┐        ┌─ hosted relay ─┐        ┌─ your box / VPS ────────────┐
│ session dashboard   │  wss   │ dumb E2E pipe  │  wss   │ landlined (Rust daemon)     │
│ TUI grid (Skia)     ├───────►│ pairing, push  ├───────►│ ├ session mgr (PTY+VT)      │
│ spawn/kill/notify   │        └────────────────┘        │ ├ state detect (blocked…)   │
└─────────────────────┘   (or direct LAN/Tailscale)      │ ├ message bus               │
                                                         │ └ unix socket + ws API      │
┌─ terminal client ───┐            unix socket           │                             │
│ landline attach     ├─────────────────────────────────►│  sessions also call         │
│ landline spawn/send │                                  │  `landline` CLI to spawn/   │
└─────────────────────┘                                  │  message each other         │
                                                         └─────────────────────────────┘
```

### Components

1. **`landlined`** (Rust) — the runtime. Owns sessions; survives client
   disconnects; persists scrollback + event log. Crates: `portable-pty`,
   `libghostty-vt`, `tokio`, `axum` (ws).
2. **`landline`** (same binary, subcommands) — human use (`attach`, `ls`,
   `spawn`, `kill`) *and* the orchestration surface agents themselves use
   (`landline spawn`, `landline send <session> <msg>`, `landline wait`),
   over the unix socket.
3. **Relay** (Rust, later milestone) — dumb encrypted WebSocket pipe + device
   pairing (QR) + push notification fan-out. Zero knowledge: E2E between app
   and daemon (libsodium-style keys exchanged at pairing).
4. **Mobile app** (Expo / React Native) — dashboard (session states, blocked
   notifications), spawn flow (harness preset, cwd, initial prompt), terminal
   view = `@shopify/react-native-skia` cell grid fed by snapshot/diff stream,
   input incl. special-keys bar (Esc/Tab/Ctrl/arrows).

### Key concepts

- **Session**: environment × harness × interface — an execution environment,
  a command in a PTY inside it, a VT screen, and metadata (harness, cwd,
  labels, state). Harness-agnostic by construction.
- **Environment**: where a session executes, behind an `Environment` trait the
  session manager provisions before exec: `host` (plain process) and `docker`
  (image, mounts, network policy, resource limits, per-session container) at
  first; microVM (firecracker/cloud-hypervisor), remote-over-SSH, and hosted
  cloud sandboxes later — the hosted product is this same trait implemented
  server-side. The trait's contract is: provision → yield a PTY-capable exec
  handle → teardown. Isolation is per *session*, not per daemon.
- **Harness profile**: preset launch command + state-detection patterns
  (working/blocked/done/idle) per agent CLI. Data, not code — user-extensible.
- **SpawnSpec & templates**: every spawn — CLI flag, phone tap, or
  agent-initiated — resolves to one declarative `SpawnSpec` (workspace +
  environment + harness + setup + env). A **template** is a named,
  parameterized SpawnSpec stored as data; clients reference templates and
  supply params, they never construct configs. See "Templates".
- **Mixed fleets are the normal case, not a mode**: the daemon holds N
  concurrent sessions across different harnesses *and* different environments
  at once (e.g. Claude Code on host + Codex in a container + OpenCode in
  another). Nothing in the runtime is keyed to a provider — harness and
  environment are per-session properties, and the dashboard, message bus, and
  orchestration CLI operate uniformly across all of them.
- **Message bus**: `send` injects text into the target session's stdin as a
  prompt (with optional prefix framing); also carries structured events
  (session spawned/exited/blocked) that other sessions or clients subscribe to.
- **Wire protocol**: JSON control plane (spawn/kill/list/subscribe/resize),
  binary data plane (snapshots, dirty-line diffs, input keys). One protocol
  for unix socket, LAN, and relay paths.

## Templates

Reliable, repeatable session startup ("start work on this repo, configured
like this") without hardcoding, built on one rule: **a template is a named,
parameterized SpawnSpec** — the same schema the CLI's inline flags map onto.
Templates compose the other registries (environment specs, harness profiles)
by reference; all three are data, user-extensible, never code.

```toml
# .landline/templates/webapp-fix.toml  (repo-local)
# or ~/.config/landline/templates/     (user-global)
schema = 1
name = "webapp-fix"
description = "Agent on the webapp repo in an isolated container"

[params]                      # phone/CLI auto-generate the spawn form from this
branch = { default = "main" }
prompt = { required = true }

[workspace]
repo = "git@github.com:me/webapp.git"
ref = "{{branch}}"
strategy = "worktree"         # clone | worktree | dir

[environment]
use = "docker-node"           # named environment spec; inline overrides allowed

[harness]
use = "claude-code"           # named harness profile
args = ["--permission-mode", "acceptEdits"]
initial_prompt = "{{prompt}}"

[setup]                       # runs in the environment before the harness
run = ["mise install", "pnpm install"]

[env]
GITHUB_TOKEN = { secret = "gh-token" }   # by reference; values never in files
```

Rules:

- `landline spawn webapp-fix -p branch=fix/auth -p prompt="fix login"`; the
  mobile spawn flow is: pick template → fill params form → go.
- Interpolation is `{{param}}` substitution only — no conditionals, no DSL.
  Anything smarter belongs in a `[setup]` script.
- Lookup order: repo-local `.landline/templates/` shadows user-global.
- Sessions record the hash of their fully-resolved SpawnSpec, so any running
  or dead session can answer "exactly what config was this?" and be respawned.
- Later, not core: consuming `devcontainer.json` as an environment source for
  docker environments.

## Milestones

- **M1 — runtime core**: `Environment` trait with `host` impl, spawn a
  session, headless VT screen, `landline attach` in a terminal over the unix
  socket rendering from snapshot+diffs. *Proves the core bet end-to-end
  locally.*
- **M2 — docker environments + registries**: second `Environment` impl —
  per-session container (image, workspace mount, limits), PTY via exec — and
  the data registries: SpawnSpec, environment specs, harness profiles,
  templates with params. *Proves the environment abstraction with two real
  impls before host assumptions bake in.*
- **M3 — network protocol**: axum WebSocket server; throwaway xterm.js debug
  page to validate remote attach and the diff protocol.
- **M4 — mobile v0**: Expo app, direct connect (LAN/Tailscale): session list,
  spawn/kill (template picker + params form), Skia terminal render,
  keyboard input.
- **M5 — relay + pairing**: hosted relay, QR pairing, E2E encryption, push
  notifications on blocked/done.
- **M6 — orchestration**: agent-facing CLI (`spawn`/`send`/`wait`), message
  bus, state detection per harness profile.
- **M7+ — hosted compute**: the `Environment` trait implemented against
  cloud sandboxes; landlined-as-a-service per user.

## Repo layout (target)

```
crates/landlined/      # daemon + CLI (one binary)
crates/proto/           # wire protocol types, shared by daemon & relay
crates/relay/           # M4
apps/mobile/            # Expo app
docs/
```

## Verification per milestone

- M1: `landline spawn -- claude` then `landline attach` in another terminal;
  run a full-screen TUI (claude, htop, vim) and confirm faithful rendering,
  detach/reattach with instant snapshot. (Sessions live in the daemon;
  surviving a daemon restart is a later persistence milestone.)
- M2: `landline spawn --env docker --image ubuntu -- htop` renders identically
  to a host session; killing the session removes the container; host and
  docker sessions run side by side; a repo-local template spawns a
  correctly-configured session twice in a row from one command.
- M3: open debug page against a session over LAN; compare against terminal.
- M4: on-device: spawn from phone into a docker environment, drive a Claude
  Code session, kill it.
- M6: one session spawns a second and receives its "done" event.
