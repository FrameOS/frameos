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

# Compiled-scene parameters from the backend (e.g. "-d:frameosSceneName=clock");
# empty for a generic image.
EXTRA_NIM_FLAGS="${FRAMEOS_EXTRA_NIM_FLAGS:-}"
# nimble.paths at nimble.lock's packages, every one of them (nimble setup
# when it is missing or older than the lock).
python3 "$FRAMEOS_DIR/tools/nimble_paths.py"

if [[ -n "${FRAMEOS_PIXIE_PATH:-}" ]]; then
    if [[ ! -d "$FRAMEOS_PIXIE_PATH/src/pixie" ]]; then
        echo "FRAMEOS_PIXIE_PATH must point to a pixie checkout with src/pixie/" >&2
        exit 1
    fi
    echo "using explicit FRAMEOS_PIXIE_PATH=$FRAMEOS_PIXIE_PATH"
fi

echo "generating FrameOS app loaders"
FRAMEOS_ROOT_DIR="$FRAMEOS_DIR" python3 "$FRAMEOS_DIR/tools/makeapploaders.py"

cd "$FRAMEOS_DIR"
# -d:pixieNoPpm drops pixie's Netpbm (P3/P6) codec, ~7.4 KB of an image that
# runs at 93% of its OTA slot. No frame is ever handed a .ppm: the format has
# no place in a web fetch, a scene asset or an upload, and every other decoder
# stays. Pi builds keep it (flash is not scarce there).
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
    -d:pixieNoPpm \
    --nimcache:"$NIMCACHE" \
    src/embedded/embedded_main.nim

# The generated C includes nimbase.h from the compiler's lib dir
NIM_LIB="$(nim --hints:off dump --dump.format:json dummy 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["libpath"])')"
cp "$NIM_LIB/nimbase.h" "$NIMCACHE/"

# Only *.c is compiled; drop the json metadata to keep the component clean
rm -f "$NIMCACHE"/*.json

# One out-of-line copy of each inline helper instead of one per C file
# (~30 KB of flash; see the script).
python3 "$SCRIPT_DIR/tools/fold_nim_inlines.py" "$NIMCACHE"

echo "nimcache ready: $(ls "$NIMCACHE" | wc -l | tr -d ' ') files in $NIMCACHE"
