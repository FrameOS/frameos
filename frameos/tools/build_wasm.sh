#!/usr/bin/env bash
# Build the FrameOS interpreted-scene runtime (src/wasm/wasm_main.nim) to a
# WebAssembly ES module with emscripten, for the frontend's live-preview
# modal. Outputs frameos.js + frameos.wasm.
#
#   ./tools/build_wasm.sh                 # release build -> ../frontend/public/frameos-wasm
#   ./tools/build_wasm.sh --out DIR       # custom output directory
#   ./tools/build_wasm.sh clean           # remove build artifacts + nimcache
#
# Requirements: nim (2.2+), nimble, python3, emscripten (emcc/emar on PATH).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRAMEOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FRAMEOS_DIR/.." && pwd)"

BUILD_DIR="$FRAMEOS_DIR/build/wasm"
NIMCACHE="$FRAMEOS_DIR/.nimcache-wasm"
OUT_DIR="$REPO_ROOT/frontend/public/frameos-wasm"

if [[ "${1:-}" == "clean" ]]; then
    rm -rf "$BUILD_DIR" "$NIMCACHE"
    echo "removed $BUILD_DIR and $NIMCACHE"
    exit 0
fi
if [[ "${1:-}" == "--out" && -n "${2:-}" ]]; then
    OUT_DIR="$2"
fi

command -v nim >/dev/null || { echo "nim not found on PATH" >&2; exit 1; }
command -v emcc >/dev/null || { echo "emcc not found on PATH (install emscripten)" >&2; exit 1; }
command -v emar >/dev/null || { echo "emar not found on PATH (install emscripten)" >&2; exit 1; }

cd "$FRAMEOS_DIR"

# ----------------------------------------------------------- nim deps/assets
if [[ ! -d quickjs ]]; then
    nimble build_quickjs --silent
fi
if [[ ! -f nimble.paths ]]; then
    nimble setup --silent
fi
FRAMEOS_ROOT_DIR="$FRAMEOS_DIR" python3 tools/makeapploaders.py
python3 tools/prepare_assets.py

# ------------------------------------------------------- QuickJS via emcc
# Engine only, no quickjs-libc — same surface as the ESP32 build
# (embedded/esp32/components/frameos_quickjs/CMakeLists.txt).
QJS_BUILD="$BUILD_DIR/quickjs"
QJS_VERSION="$(head -n1 quickjs/VERSION)"
mkdir -p "$QJS_BUILD"

qjs_needs_build=0
for src in quickjs.c dtoa.c libregexp.c libunicode.c cutils.c; do
    obj="$QJS_BUILD/${src%.c}.o"
    if [[ ! -f "$obj" || "quickjs/$src" -nt "$obj" ]]; then
        qjs_needs_build=1
    fi
done
if [[ "$qjs_needs_build" == "1" || ! -f "$QJS_BUILD/libquickjs.a" ]]; then
    echo "building QuickJS $QJS_VERSION with emcc"
    for src in quickjs.c dtoa.c libregexp.c libunicode.c cutils.c; do
        emcc -c -O2 \
            -D_GNU_SOURCE \
            -DCONFIG_VERSION="\"$QJS_VERSION\"" \
            -funsigned-char -fwrapv -fno-strict-aliasing -w \
            "quickjs/$src" -o "$QJS_BUILD/${src%.c}.o"
    done
    emar rcs "$QJS_BUILD/libquickjs.a" "$QJS_BUILD"/*.o
fi

# --------------------------------------------------------------- nim -> wasm
FRAMEOS_VERSION="$(python3 tools/frameos_version.py ../versions.json)"

# _main keeps Nim's generated main() alive: emscripten calls it on module
# startup and that runs NimMain (all Nim module initializers, e.g. the
# baked-in font asset tables).
EXPORTED_FUNCTIONS=_main,_malloc,_free,_frameos_wasm_init,_frameos_wasm_load_scenes,_frameos_wasm_select_scene,_frameos_wasm_render,_frameos_wasm_buffer,_frameos_wasm_buffer_len,_frameos_wasm_width,_frameos_wasm_height,_frameos_wasm_event,_frameos_wasm_render_requested,_frameos_wasm_next_sleep,_frameos_wasm_scene_interval,_frameos_wasm_scene_info,_frameos_wasm_scene_state,_frameos_wasm_last_error
EXPORTED_RUNTIME_METHODS=cwrap,ccall,UTF8ToString,stringToNewUTF8,lengthBytesUTF8,HEAPU8

mkdir -p "$BUILD_DIR"

nim c \
    --cc:clang \
    --clang.exe:emcc \
    --clang.linkerexe:emcc \
    --os:linux \
    --cpu:wasm32 \
    -d:emscripten \
    -d:frameosWasm \
    --mm:orc \
    --threads:off \
    --exceptions:goto \
    -d:release \
    --opt:size \
    -d:useMalloc \
    -d:noSignalHandler \
    --define:frameosVersion:"$FRAMEOS_VERSION" \
    --nimcache:"$NIMCACHE" \
    --out:"$BUILD_DIR/frameos.js" \
    --passL:"-sMODULARIZE=1" \
    --passL:"-sEXPORT_ES6=1" \
    --passL:"-sEXPORT_NAME=createFrameOS" \
    --passL:"-sENVIRONMENT=web,worker" \
    --passL:"-sALLOW_MEMORY_GROWTH=1" \
    `# Growable memory via resizable ArrayBuffers (GROWABLE_ARRAYBUFFERS=1,` \
    `# the default) makes wasmMemory.buffer resizable, and Chrome's` \
    `# TextDecoder.decode() refuses views over a resizable ArrayBuffer` \
    `# ("must not be resizable") for any string >16 bytes. Force copy-on-grow` \
    `# (non-resizable buffers) so string decoding works in the browser.` \
    --passL:"-sGROWABLE_ARRAYBUFFERS=0" \
    --passL:"-sINITIAL_MEMORY=64MB" \
    --passL:"-sSTACK_SIZE=8MB" \
    --passL:"-sASSERTIONS=0" \
    --passL:"-sINCOMING_MODULE_JS_API=wasmBinary,locateFile,print,printErr,onRuntimeInitialized,onAbort" \
    --passL:"-sEXPORTED_FUNCTIONS=$EXPORTED_FUNCTIONS" \
    --passL:"-sEXPORTED_RUNTIME_METHODS=$EXPORTED_RUNTIME_METHODS" \
    --passL:"--js-library $FRAMEOS_DIR/tools/wasm/frameos_library.js" \
    src/wasm/wasm_main.nim

mkdir -p "$OUT_DIR"
cp "$BUILD_DIR/frameos.js" "$BUILD_DIR/frameos.wasm" "$OUT_DIR/"
if [[ -f "$SCRIPT_DIR/wasm/preview-worker.js" ]]; then
    cp "$SCRIPT_DIR/wasm/preview-worker.js" "$OUT_DIR/"
fi

echo "wasm bundle ready in $OUT_DIR:"
ls -la "$OUT_DIR"
