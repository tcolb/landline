#!/usr/bin/env bash
# End-to-end protocol tests against a freshly started daemon.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build
# `[l]` keeps the pattern from matching this script's own command line.
pkill -9 -f '[l]andline daemon' 2>/dev/null || true
rm -f "${XDG_RUNTIME_DIR:-/tmp}/landline.sock"
sleep 0.3
export LANDLINE_STUB_STATE="$(mktemp -d)"
# The daemon launches sessions in arbitrary cwds where mise shims may not
# resolve; pin the stub to a concrete interpreter via a generated wrapper.
PYTHON="$(python3 -c 'import sys; print(sys.executable)')"
cat > "$LANDLINE_STUB_STATE/runtime" <<WRAP
#!/bin/sh
exec "$PYTHON" "$PWD/scripts/e2e/stub-runtime" "\$@"
WRAP
chmod +x "$LANDLINE_STUB_STATE/runtime"
export LANDLINE_CONTAINER_RUNTIME="$LANDLINE_STUB_STATE/runtime"
# Daemon-level config with lifecycle hooks (verified by net.py).
mkdir -p "$LANDLINE_STUB_STATE/config"
cat > "$LANDLINE_STUB_STATE/config/config.toml" <<'HOOKS'
[hooks]
session_created = "echo created $LANDLINE_SESSION_NAME >> $LANDLINE_STUB_STATE/hooks.log"
session_exited = "echo exited $LANDLINE_SESSION_NAME:$LANDLINE_EXIT_CODE >> $LANDLINE_STUB_STATE/hooks.log"
HOOKS
export LANDLINE_CONFIG_DIR="$LANDLINE_STUB_STATE/config"
export LANDLINE_WS_ADDR="127.0.0.1:7181"
# Start the daemon explicitly (not via autostart) so it serves WebSocket too.
# Wait on the socket file — `landline ls` would autostart a rival daemon.
setsid target/debug/landline daemon --ws "$LANDLINE_WS_ADDR" \
  > "$LANDLINE_STUB_STATE/daemon.log" 2>&1 &
for _ in $(seq 50); do
  [ -S "${XDG_RUNTIME_DIR:-/tmp}/landline.sock" ] && break
  sleep 0.1
done
python3 scripts/e2e/smoke.py
python3 scripts/e2e/tui.py
python3 scripts/e2e/containers.py
python3 scripts/e2e/net.py
pkill -9 -f '[l]andline daemon' 2>/dev/null || true
rm -rf "$LANDLINE_STUB_STATE"
echo "e2e: all passed"
