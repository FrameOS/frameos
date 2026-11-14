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

# The JS preludes and the scene programs' kit as bytecode built into the image
# (src/assets/prelude_bytecode.nim, docs/perf-todo.md): a host build of the
# same QuickJS compiles them once here instead of the device compiling ~10 KB
# of JavaScript at every interpreter start and scene program. The tool links quickjs/libquickjs.a, the host library beside the
# sources the firmware compiles; their VERSION is one file.
echo "compiling the JS preludes to bytecode"
# A host QuickJS from the same sources the firmware compiles, without
# quickjs-libc (the tool needs none of it), so the tool links whatever libc
# this host has: the prebuilt quickjs/libquickjs.a was built elsewhere and
# did not link in the CI image (glibc's __isoc23_strtol, 2026-11-07).
HOST_QJS="build/quickjs-host"
mkdir -p "$HOST_QJS"
QJS_VERSION="$(tr -d '[:space:]' < quickjs/VERSION)"
# Side by side, and through ccache when the caller keeps one (CI's firmware
# legs set CCACHE_DIR): quickjs.c alone is most of the ~30 s these took one
# after another in a fresh CI checkout, every leg, every run (2026-11-14).
host_cc=(gcc)
if [[ -n "${CCACHE_DIR:-}" ]] && command -v ccache >/dev/null; then
    host_cc=(ccache gcc)
fi
pids=()
for src in quickjs libregexp libunicode cutils dtoa; do
    if [[ ! -f "$HOST_QJS/$src.o" || quickjs/$src.c -nt "$HOST_QJS/$src.o" ]]; then
        "${host_cc[@]}" -O2 -D_GNU_SOURCE -DCONFIG_VERSION="\"$QJS_VERSION\"" -Iquickjs -c "quickjs/$src.c" -o "$HOST_QJS/$src.o" &
        pids+=("$!")
    fi
done
# (The guarded expansion: an empty array is "unbound" to macOS's bash 3.2.)
for pid in ${pids[@]+"${pids[@]}"}; do
    wait "$pid"
done
rm -f "$HOST_QJS/libquickjs.a"
ar rcs "$HOST_QJS/libquickjs.a" "$HOST_QJS"/*.o
nim c --hints:off -d:release -d:frameosQuickjsNoLibc -d:frameosQuickjsLib="$HOST_QJS/libquickjs.a" \
    -o:build/prelude_bytecode tools/prelude_bytecode.nim
./build/prelude_bytecode

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
    -d:frameosPreludeBytecode \
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
