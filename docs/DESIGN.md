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

## Interop: an open runtime, many frontends

`landlined` is a substrate, not a walled garden: any frontend — a
terminal-native multiplexer TUI, a desktop IDE with its own xterm-style
emulator, a web dashboard, or our mobile app — can serve sessions from the
same daemon, and `landline` can remote into sessions those frontends created.
Three design rules make that hold:

1. **The protocol is the product boundary.** It is documented in
   `docs/PROTOCOL.md` (deliverable of M3), versioned, with capability
   negotiation at connect (client states protocol version + wanted
   features). `landline-proto` is published as a crate, and the protocol is
   plain JSON (binary frames negotiated as an optimization) so non-Rust
   clients need no code from us.
2. **Two attach altitudes.** `Attach { mode }` chooses:
   - `frames` — server-rendered snapshot + dirty-row diffs, for thin
     clients that just paint cells (our mobile app, web dashboards).
   - `bytes` — raw PTY passthrough for clients that bring their own
     emulator. On attach, the daemon synthesizes the current screen as a VT
     escape-sequence stream from its server-side state (libghostty's `fmt`
     supports rendering state back to VT sequences), so byte clients get an
     instant live picture mid-session — tmux-attach semantics — then the
     raw feed. Input and resize are identical in both modes.
3. **Control plane stands alone.** Spawn/ls/kill/templates/events (state
   changes, exits, blocked signals) are usable without attaching at all, so
   orchestrators and dashboards can manage fleets without terminal streams.

### The shim pattern: hosting landline sessions in other frontends

Because `landline attach --mode bytes` turns any session into an ordinary
local PTY-producing command, **any frontend that can run a command in a pane
can host a landline session** — terminal-native multiplexers, desktop IDEs
with embedded terminals, plain tmux, a bare terminal. The host sees a normal
process emitting normal escape codes; the process is a thin client relaying a
session that actually lives in `landlined` (possibly inside a container the
host knows nothing about). Resizes propagate (the shim forwards SIGWINCH),
closing the pane merely detaches, and the mid-session reconstruction snapshot
means the pane shows the live screen instantly.

The push direction — a session spawned from the phone automatically
appearing as a pane in a running frontend — composes from two generic
primitives, so nothing frontend-specific lives in the core:

- **Lifecycle events** on the control plane (`watch`): session created /
  exited, carrying the session info.
- **Lifecycle hooks** in daemon config: `on session_created`, run a
  user-configured command with `LANDLINE_SESSION_*` env vars.

A per-frontend adapter is then a small script: subscribe (or hook), call the
host frontend's own spawn surface with `landline attach --mode bytes <id>` as
the command. Adapters live outside this repo; extensibility here means the
daemon's job ends at events + hooks + the bytes shim.

Later bridges, not core: an ACP session type (chat-altitude clients), AHP
alignment for multi-client turn semantics, and possibly the tmux
control-mode dialect so terminals that already speak it can attach natively.

### Tracked upstream: libghostty binary snapshot format (GHOSTSNP)

ghostty main now carries a binary terminal-snapshot codec
(`include/ghostty/vt/snapshot.h`, format v1): a CRC32C-protected record
stream encoding complete terminal state — including unfinished VT parser
input — with a `READY` marker after the renderable prefix and scrollback
history pages ordered for incremental prepend. As of this writing it is
NOT in the released Rust crate (0.2.1) and the format explicitly carries
no binary-compatibility guarantee, so we track rather than adopt.

When it ships stable, three adoption points, all additive:

1. **Third negotiated attach encoding** for clients that embed
   libghostty (incl. potentially our app via their WASM build): superior
   to the VT-dump reconstruction because it restores mid-escape-sequence
   parser state exactly, where escape replay can glitch.
2. **Scrollback transfer**: the render-at-READY-then-backfill-history
   decode shape is exactly the on-demand scrollback protocol we want.
3. **Retention/persistence**: snapshot-to-disk so screen state and
   scrollback survive daemon restarts (process state still dies; screen
   state need not).

JSON frames stay the thin-client baseline and escape-code bytes mode the
universal shim; GHOSTSNP would slot in via `hello` feature negotiation.

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

   **Core tenet: native-first UI.** Outside the terminal canvas (inherently
   custom drawing), each platform's app should look and feel native to that
   platform — platform UI components (SwiftUI-backed on iOS,
   Compose-backed on Android, e.g. via `@expo/ui`), native navigation
   stacks and transitions, system colors/dynamic type, platform-idiomatic
   lists, context menus, and haptics. Custom-styled generic views are the
   fallback, not the default; a screen that could be a native form or
   grouped list should be one.

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
  data plane with two attach modes — rendered `frames` for thin clients,
  raw `bytes` for clients with their own emulator (see "Interop"). One
  protocol for unix socket, LAN, and relay paths.

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

## Agent-first, not multiplexer-first

landline is an agent session runtime that happens to render terminals —
not a terminal multiplexer with agents bolted on. Practically:

- **Templates are the primary spawn surface.** Spawning means picking an
  agent preset (template) and filling its parameters; clients render a
  picker fed by the `templates` protocol request. Inline commands remain
  as the debug escape hatch, tucked behind "advanced".
- **Agent and environment are independent, both selectable.** A template
  names the agent (and a default environment), but the spawn surface
  exposes environment as an overridable second dimension fed by the
  `environments` request — "run webapp-fix, but in the ubuntu container
  this time" without minting a new template. Spawn precedence:
  `image` > named `env` > template environment > host.
- Sessions are described by intent (which agent, which repo, which
  branch), not by command lines; the registry system (environments,
  harnesses, templates) is where that intent lives.
- Future orchestration (M6: spawn/send/wait, state detection) builds on
  the same template identity: an agent spawning a helper names a template,
  not a shell command.

### Session interfaces: terminal, chat, hybrid

The interface axis of a session (environment × harness × interface) has
three values, and **harness capability decides which are available — none
is guaranteed universal**:

- **terminal** — the PTY TUI, served as frames/bytes. Universal: any
  program that runs in a terminal.
- **chat** — a chat-native session: the harness runs in its structured
  mode (ACP, RPC, stream-JSON) and the daemon maintains a message log
  instead of (not alongside) a TUI. Breadth path for headless agents.
- **hybrid** — terminal AND chat as two live projections of one process.
  Possible exactly when the harness emits a semantic mirror of its
  interactive session; verified for Claude Code (live transcript JSONL
  under `~/.claude/projects/<cwd-slug>/`) and documented for pi
  (`~/.pi/agent/sessions/…`, documented entry types). Chat input types
  into the PTY; switching views is instant because nothing switches —
  both attach modes are live simultaneously.

Templates/harnesses declare capability (`[chat] format = "claude"`);
clients render the Terminal | Chat toggle only when the session has it.
The daemon's chat log is the semantic sibling of the VT screen: same
architecture (server-side state, snapshot on attach, deltas after,
resync by snapshot), different state type. Spawn-time env sanitation is
mandatory — inherited harness markers (e.g. nested-session flags) can
silently disable the mirrors.

### Repo-centric workspaces

"Spin up claude for a repo" is the primary flow; a fixed directory in a
template is only the local-dev special case. Staged:

1. **Clone workspace strategy** (implemented): `workspace.strategy =
   "clone"` with an interpolatable `repo` URL + `ref`. The daemon keeps a
   mirror clone per repo under `~/.local/share/landline/repos/` (fetched
   on reuse, non-fatally) and hands each session its own worktree. Git
   auth is whatever the daemon host has — ssh keys, forge CLI credential
   helpers; the daemon acts as the user.
2. **Repo discovery + typed params**: a `repos` source for pickers —
   registry files first, then forge CLI enumeration (`gh repo list`
   style). Template params gain optional types (`repo`, `git-ref`,
   `path`, `choice`) so clients render the right picker per param instead
   of a bare text field; a `repo`-typed param feeds from discovery, a
   `git-ref` param can enumerate branches of the chosen repo.
3. **Forge connections** (relay/hosted era): OAuth/App-based GitHub and
   GitLab connections for the hosted product, where "the daemon acts as
   the user" no longer applies. Self-hosted keeps CLI credentials.

## Responsiveness budget

"Feels instant" is a measured budget, not a vibe. Targets:

- keystroke → painted echo ≤ network RTT + 25 ms
- attach → first paint ≤ 100 ms on LAN (serve cached last-known frame
  immediately, reconcile when the fresh snapshot lands)
- scrolling at native refresh rate, entirely client-local

What enforces it, by layer:

- **Daemon**: adaptive frame tick — after a quiet period the first diff is
  emitted immediately, so interactive echo never waits out the coalescing
  interval; only continuous output is coalesced on the 16 ms tick. Input is
  written to the PTY per event, never batched. `TCP_NODELAY` on every hop.
- **Client**: dirty-row-only repaint with a cached laid-out paragraph per
  row; local scrollback cache so flicks never round-trip; optimistic
  control-plane UI (spawn/kill update the list in a pending state,
  reconciled by `watch` events); a debug overlay showing echo RTT and frame
  age so regressions are visible the day they happen.
- **Relay (M5)**: a dumb byte pipe — no parsing, no queuing — deployed near
  the user; prefer direct LAN/tunnel paths when reachable, relay as
  fallback.
- **Later**: mosh-style predictive local echo (client paints typed
  characters immediately, marked until confirmed). State-sync frames make
  this safe — an authoritative frame cleanly overwrites any misprediction.
  This is the single biggest perceived-latency win on high-RTT links.

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
- **M3 — network protocol + interop**: axum WebSocket server (token-gated);
  `bytes` attach mode with VT-reconstruction snapshot; SIGWINCH propagation
  in the attach client (mandatory for shim hosting); lifecycle events
  (`watch`) + daemon config hooks (`session_created`/`session_exited`);
  `docs/PROTOCOL.md` with version/capability negotiation; final-screen
  retention for exited sessions (today the VT thread ends with the child, so
  postmortem attach shows nothing — the last screen should stay servable);
  throwaway xterm.js debug page validating both attach modes remotely
  (frames mode hand-rendered, bytes mode fed straight into the page's
  emulator).
- **M4 — mobile v0**: Expo app, direct connect (LAN/Tailscale): session list
  kept live by `watch`, spawn/kill (template picker + params form), Skia
  terminal render, keyboard input incl. special-keys bar, in-app latency
  overlay (echo RTT, frame age). Distribution: CI (macOS runner) builds an
  unsigned iOS `.ipa` published via a SideStore source feed — milestone
  exit is a SideStore link an iOS user can install from (no App Store, no
  paid dev account; users re-sign with their own Apple ID). Android gets
  the same via a release APK.
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
crates/relay/           # M5
apps/mobile/            # Expo app (M4)
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
- M3: open debug page against a session over LAN in both attach modes;
  byte-mode attach mid-session shows the live screen instantly; a
  third-party terminal fed the byte stream renders identically.
- M4: on-device: spawn from phone into a docker environment, drive a Claude
  Code session, kill it; a fresh iOS device installs the app from the
  published SideStore source link.
- M6: one session spawns a second and receives its "done" event.
