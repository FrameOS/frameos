#!/usr/bin/env bash
# The dev stack's `wasm` pane (mprocs.yaml): build_wasm.sh once, then again
# whenever the runtime's sources change. The bundle it writes
# (frontend/public/frameos-wasm) is what the backend renders frames with:
# thin clients, boards set to render on the server, virtual frames, the
# preview. A dev stack left running across merges kept a bundle from before
# them, and the backend drew with yesterday's runtime: an E1003 rendered on
# the server lost its keyboard and its selects at every pull, a bundle
# without the kept-state exports (2026-11-13).
#
# Polls (no file watcher to install): every few seconds, any Nim, C or shell
# source under frameos/src, frameos/pixie/src or frameos/tools/wasm newer than
# the last build's start. The files a build writes itself (src/assets, the app
# loaders) are not sources.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRAMEOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
POLL_SECONDS="${FRAMEOS_WASM_WATCH_SECONDS:-5}"
MARK="$(mktemp -t frameos-wasm-watch.XXXXXX)"
trap 'rm -f "$MARK"' EXIT

changed() {
    find "$FRAMEOS_DIR/src" "$FRAMEOS_DIR/pixie/src" "$FRAMEOS_DIR/tools/wasm" "$FRAMEOS_DIR/tools/build_wasm.sh" \
        -newer "$MARK" -type f \( -name '*.nim' -o -name '*.nims' -o -name '*.c' -o -name '*.h' -o -name '*.sh' \) \
        -not -path "$FRAMEOS_DIR/src/assets/*" -not -name 'app_loader.nim' -print -quit 2>/dev/null
}

build() {
    # Marked before it starts: an edit made while it runs is built next.
    touch "$MARK"
    echo "[wasm] building ($(date +%H:%M:%S))"
    if bash "$SCRIPT_DIR/build_wasm.sh"; then
        echo "[wasm] built ($(date +%H:%M:%S)); watching for changes"
    else
        echo "[wasm] build failed ($(date +%H:%M:%S)); trying again on the next change"
    fi
}

build
while sleep "$POLL_SECONDS"; do
    first="$(changed)"
    if [[ -n "$first" ]]; then
        echo "[wasm] changed: ${first#"$FRAMEOS_DIR/"}"
        build
    fi
done
