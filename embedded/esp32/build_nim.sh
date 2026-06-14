#!/usr/bin/env bash
# Compile the FrameOS embedded Nim runtime (frameos/src/embedded) to C and
# drop it into components/frameos_nim/nimcache for the IDF build.
#
#   ./build_nim.sh          # build nimcache
#   ./build_nim.sh clean    # remove nimcache (firmware falls back to stub)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FRAMEOS_DIR="$REPO_ROOT/frameos"
NIMCACHE="$SCRIPT_DIR/components/frameos_nim/nimcache"

if [[ "${1:-}" == "clean" ]]; then
    rm -rf "$NIMCACHE"
    echo "removed $NIMCACHE"
    exit 0
fi

command -v nim >/dev/null || { echo "nim not found on PATH" >&2; exit 1; }

rm -rf "$NIMCACHE"
mkdir -p "$NIMCACHE"

# Compiled-scene parameters from the backend (e.g. "-d:frameosSceneName=clock
# -d:frameosSceneBackground=#000000"); empty for a generic image.
EXTRA_NIM_FLAGS="${FRAMEOS_EXTRA_NIM_FLAGS:-}"
if [[ -n "${FRAMEOS_PIXIE_PATH:-}" ]]; then
    if [[ ! -d "$FRAMEOS_PIXIE_PATH/src/pixie" ]]; then
        echo "FRAMEOS_PIXIE_PATH must point to a pixie checkout with src/pixie/" >&2
        exit 1
    fi
fi

cd "$FRAMEOS_DIR"
# shellcheck disable=SC2086
nim c \
    $EXTRA_NIM_FLAGS \
    --compileOnly \
    --os:freertos \
    --cpu:esp \
    --mm:orc \
    --threads:off \
    --exceptions:goto \
    --noMain \
    --opt:size \
    -d:release \
    -d:useMalloc \
    -d:noSignalHandler \
    -d:frameosEmbedded \
    --nimcache:"$NIMCACHE" \
    src/embedded/embedded_main.nim

# The generated C includes nimbase.h from the compiler's lib dir
NIM_LIB="$(nim --hints:off dump --dump.format:json dummy 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["libpath"])')"
cp "$NIM_LIB/nimbase.h" "$NIMCACHE/"

# Only *.c is compiled; drop the json metadata to keep the component clean
rm -f "$NIMCACHE"/*.json

echo "nimcache ready: $(ls "$NIMCACHE" | wc -l | tr -d ' ') files in $NIMCACHE"
