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
target/debug/landline ls >/dev/null   # autostarts the daemon (inherits env)
python3 scripts/e2e/smoke.py
python3 scripts/e2e/tui.py
python3 scripts/e2e/containers.py
rm -rf "$LANDLINE_STUB_STATE"
echo "e2e: all passed"
