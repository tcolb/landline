#!/usr/bin/env bash
# End-to-end protocol tests against a freshly started daemon.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build
# `[l]` keeps the pattern from matching this script's own command line.
pkill -9 -f '[l]andline daemon' 2>/dev/null || true
rm -f "${XDG_RUNTIME_DIR:-/tmp}/landline.sock"
sleep 0.3
target/debug/landline ls >/dev/null   # autostarts the daemon
python3 scripts/e2e/smoke.py
python3 scripts/e2e/tui.py
echo "e2e: all passed"
