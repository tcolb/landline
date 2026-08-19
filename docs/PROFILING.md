# Profiling the terminal pipeline

The responsiveness budget (DESIGN.md) is only enforceable if every stage of
the pipeline is measurable with real numbers. This is the plan for
instrumenting both sides, correlating them, and generating reproducible
load. Debug-by-anecdote (hold a key, guess which stage lagged) does not
scale past the first bug.

## The stage map

```
INPUT   phone JS handler → base64/JSON → native WS ─┐
                                                    │ network
DAEMON  WS read → dispatch → input chan → PTY write ┘
APP     harness processes, writes PTY output
DAEMON  PTY read → VT thread (ghostty write, adaptive tick, diff())
        → serde serialize → broadcast → per-client chan → WS write ─┐
                                                                    │ network
CLIENT  native WS → JS message queue → JSON.parse → applyFrame      │
        → dirty-row mark → rAF → recordRow/compose → React commit ──┘
        → Skia render → vsync
```

Every past bug lived in a different stage (adaptive tick: daemon; reanimated:
client boot; held-backspace: JS message queue). The instrumentation must
localize a regression to a stage without a hypothesis in advance.

## Clock strategy: sequence/ack correlation

Cross-machine timestamps are useless without clock sync. Instead:

- `input` messages gain an optional `seq` (client-monotonic counter).
- Frames gain an optional `ack`: the highest input `seq` the daemon had
  written to the PTY at the moment the frame was generated.

All end-to-end latency is then computed on the client's clock alone:
`t_painted(frame with ack >= s) - t_sent(input s)`. The daemon separately
self-reports server-side deltas on its own clock. Both fields are additive
protocol changes (PROTOCOL.md update, defaults preserved for old peers).

This replaces the current echo metric, which measures "send → next arriving
frame" and reads 23 ms while the screen is seconds behind under load.

## Daemon instrumentation

A per-session `Stats` registry (plain atomics + fixed-bucket histograms, no
new dependencies), collected in the VT thread and connection tasks:

- **input**: recv→PTY-write latency histogram; inputs/sec.
- **vt**: bytes/sec in; `screen.write` and `screen.diff` duration
  histograms; rows per diff; frames/sec; adaptive-tick immediate vs
  coalesced counts.
- **serialize**: JSON bytes per frame histogram; bytes/sec per client.
- **delivery**: broadcast `Lagged` resyncs (server-visible slow consumer);
  out-channel high-water mark; WS write stall time.
- **app time** (via seq/ack): `t_frame_emitted - t_input_written` for the
  acked seq — isolates harness processing time from transport and render.

Exposed via a new control-plane request `{"type": "stats", "session": ID}`
returning the whole registry as JSON — queryable by the CLI, tests, the
debug page, and the app itself. No push channel, no new transport; polling
is fine for profiling.

## Client instrumentation

A stats module fed by timers at each stage, displayed in an expandable
debug panel (tap the status bar) and dumpable as JSON to the Metro console:

- **e2e input latency**: seq/ack correlated, p50/p95/max, last value —
  the headline number, honest under load.
- **breakdown**: server delta (daemon-reported) vs network+client
  remainder; parse ms; applyFrame ms; recordRow count+ms and compose ms
  per rAF; React-commit-to-next-rAF gap.
- **backlog detection**: messages drained per rAF tick (persistently >1 =
  JS thread behind), plus WS `bufferedAmount` where available.
- **frame rate**: rAF cadence histogram; dropped-frame count.
- **volume**: frames/sec, bytes/sec, rows/frame.

Existing tools ride along: Hermes sampling profiler via Metro/Chrome
DevTools for JS flamegraphs (works from this machine), Xcode Instruments
only via the macOS CI runner if ever needed.

## Reproducible load

Real data needs repeatable scenarios, not thumbs on keys:

- **`scripts/e2e/bench.py`** (daemon side, CI-runnable): drives a real
  daemon over WS with scripted loads — typing at fixed cps, held-key
  repeat, `yes`-flood, vim scroll storm, claude-like input-box redraw
  (synthetic escape script replayed through a session). Asserts against
  budget numbers (write/diff duration ceilings, input→frame ack latency
  over loopback, frames coalesced under flood) so regressions fail CI.
- **mock-daemon storm modes** (client side): `mock-daemon.py --storm
  rows=N fps=M` generates synthetic diff storms and huge snapshots to
  drive the app (or the CI simulator autotest) at controlled intensity;
  the client stats panel provides the read-out.

## Budgets become assertions

From DESIGN.md, now checkable: keystroke→painted ≤ RTT+25 ms (client
panel, seq/ack); daemon write+diff ≤ 2 ms p95 at 80×50; flood coalescing
≥ 100:1; client compose ≤ 8 ms p95; zero JS backlog at 60 fps diff rate.

## Implementation order

1. **seq/ack** in proto + daemon + client, replacing the echo metric
   (small, unlocks every honest number).
2. Client stats module + debug panel.
3. Daemon `Stats` registry + `stats` request.
4. `bench.py` scenarios + CI budget assertions.
5. mock-daemon storm modes for client-side load.
