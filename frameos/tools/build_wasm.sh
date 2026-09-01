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
#
# nimble build_quickjs may have installed a *prebuilt* QuickJS into quickjs/
# (headers + a native libquickjs.a, no C sources — see
# tools/install_prebuilt_quickjs.py). emcc needs the sources, so fetch the
# source tarball into the build dir when quickjs/ has none. Version and
# sha256 must stay in sync with the build_quickjs task in frameos.nimble.
QJS_SRC="$FRAMEOS_DIR/quickjs"
if [[ ! -f "$QJS_SRC/quickjs.c" ]]; then
    QJS_SRC="$BUILD_DIR/quickjs-src"
    if [[ ! -f "$QJS_SRC/quickjs.c" ]]; then
        QJS_TARBALL_VERSION="2026-06-04"
        QJS_TARBALL_SHA256="b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a"
        echo "quickjs/ has no C sources (prebuilt install) — downloading QuickJS $QJS_TARBALL_VERSION sources"
        mkdir -p "$BUILD_DIR"
        curl -fsSL -o "$BUILD_DIR/quickjs-src.tar.xz" \
            "https://bellard.org/quickjs/quickjs-$QJS_TARBALL_VERSION.tar.xz"
        if command -v sha256sum >/dev/null; then
            echo "$QJS_TARBALL_SHA256  $BUILD_DIR/quickjs-src.tar.xz" | sha256sum -c -
        else
            echo "$QJS_TARBALL_SHA256  $BUILD_DIR/quickjs-src.tar.xz" | shasum -a 256 -c -
        fi
        rm -rf "$QJS_SRC"
        mkdir -p "$QJS_SRC"
        tar -xf "$BUILD_DIR/quickjs-src.tar.xz" -C "$QJS_SRC" --strip-components=1
        rm "$BUILD_DIR/quickjs-src.tar.xz"
    fi
fi

QJS_BUILD="$BUILD_DIR/quickjs"
QJS_VERSION="$(head -n1 "$QJS_SRC/VERSION")"
mkdir -p "$QJS_BUILD"

qjs_needs_build=0
for src in quickjs.c dtoa.c libregexp.c libunicode.c cutils.c; do
    obj="$QJS_BUILD/${src%.c}.o"
    if [[ ! -f "$obj" || "$QJS_SRC/$src" -nt "$obj" ]]; then
        qjs_needs_build=1
    fi
done
# JS `Date` must follow the frame's configured time zone, not the browser's:
# quickjs.c reads local time exactly once, `localtime_r(&ti, &tm);` in
# getTimezoneOffset(), and that call is redirected to
# tools/wasm/fos_quickjs_tz.c, which asks the Nim runtime (lib/tz.nim) for
# the zone's offset. Fail loudly if a QuickJS update moves that line.
if ! grep -q 'localtime_r(&ti, &tm);' "$QJS_SRC/quickjs.c"; then
    echo "build_wasm.sh: quickjs.c no longer calls 'localtime_r(&ti, &tm);' in getTimezoneOffset() —" >&2
    echo "update the localtime_r redirect in tools/wasm/fos_quickjs_tz.c" >&2
    exit 1
fi
QJS_TZ_SHIM="$FRAMEOS_DIR/tools/wasm/fos_quickjs_tz.c"
if [[ "$qjs_needs_build" == "0" && ( "$QJS_TZ_SHIM" -nt "$QJS_BUILD/libquickjs.a" || "${QJS_TZ_SHIM%.c}.h" -nt "$QJS_BUILD/libquickjs.a" ) ]]; then
    qjs_needs_build=1
fi
if [[ "$qjs_needs_build" == "1" || ! -f "$QJS_BUILD/libquickjs.a" ]]; then
    echo "building QuickJS $QJS_VERSION with emcc"
    for src in quickjs.c dtoa.c libregexp.c libunicode.c cutils.c; do
        emcc -c -O2 \
            -D_GNU_SOURCE \
            -DCONFIG_VERSION="\"$QJS_VERSION\"" \
            -Dlocaltime_r=fos_quickjs_localtime_r \
            -include "${QJS_TZ_SHIM%.c}.h" \
            -funsigned-char -fwrapv -fno-strict-aliasing -w \
            "$QJS_SRC/$src" -o "$QJS_BUILD/${src%.c}.o"
    done
    emcc -c -O2 -w "$QJS_TZ_SHIM" -o "$QJS_BUILD/fos_quickjs_tz.o"
    rm -f "$QJS_BUILD/libquickjs.a"
    emar rcs "$QJS_BUILD/libquickjs.a" "$QJS_BUILD"/*.o
fi

# ------------------------------------------------- simulated device memory
# The preview can run under a device's memory ceiling (see the file's header).
# It owns the exported `frameos_wasm_render` symbol, wrapping the Nim
# `frameos_wasm_render_impl` in a setjmp guard, and Nim's allocator is patched
# to route through it (src/wasm/patched_malloc.nim via config.nims).
MEM_SHIM="$FRAMEOS_DIR/tools/wasm/fos_wasm_mem.c"
MEM_OBJ="$BUILD_DIR/fos_wasm_mem.o"
mkdir -p "$BUILD_DIR"
if [[ ! -f "$MEM_OBJ" || "$MEM_SHIM" -nt "$MEM_OBJ" || "${MEM_SHIM%.c}.h" -nt "$MEM_OBJ" ]]; then
    echo "building the simulated-memory shim with emcc"
    emcc -c -O2 -w "$MEM_SHIM" -o "$MEM_OBJ"
fi

# --------------------------------------------------------------- nim -> wasm
FRAMEOS_VERSION="$(python3 tools/frameos_version.py ../versions.json)"

# _main keeps Nim's generated main() alive: emscripten calls it on module
# startup and that runs NimMain (all Nim module initializers, e.g. the
# baked-in font asset tables).
EXPORTED_FUNCTIONS=_main,_malloc,_free,_frameos_wasm_init,_frameos_wasm_load_scenes,_frameos_wasm_select_scene,_frameos_wasm_set_fusion,_frameos_wasm_set_save_assets,_frameos_wasm_set_scene_state,_frameos_wasm_render,_frameos_wasm_buffer,_frameos_wasm_buffer_len,_frameos_wasm_width,_frameos_wasm_height,_frameos_wasm_event,_frameos_wasm_render_requested,_frameos_wasm_next_sleep,_frameos_wasm_scene_interval,_frameos_wasm_scene_info,_frameos_wasm_scene_state,_frameos_wasm_last_error,_frameos_wasm_tz_offset_seconds,_frameos_wasm_set_memory_limit,_frameos_wasm_memory_limit,_frameos_wasm_memory_used,_frameos_wasm_memory_peak,_frameos_wasm_memory_failed,_frameos_wasm_memory_reset_peak,_frameos_wasm_memory_render_headroom
# FS lets the render harness preload a virtual frame's assets into MEMFS;
# IDBFS (linked below with -lidbfs.js) backs the browser preview's
# /srv/assets folder with IndexedDB (see tools/wasm/preview-worker.js).
EXPORTED_RUNTIME_METHODS=cwrap,ccall,UTF8ToString,stringToNewUTF8,lengthBytesUTF8,HEAPU8,FS,IDBFS

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
    --passC:"-I$FRAMEOS_DIR/tools/wasm" \
    --passL:"$MEM_OBJ" \
    `# setjmp/longjmp is how a refused allocation gets out of a render` \
    `# without taking the module down (tools/wasm/fos_wasm_mem.c).` \
    --passL:"-sSUPPORT_LONGJMP=emscripten" \
    --passL:"-sMODULARIZE=1" \
    --passL:"-sEXPORT_ES6=1" \
    --passL:"-sEXPORT_NAME=createFrameOS" \
    `# node: the backend's thin-client renderer runs this same bundle under` \
    `# Node (backend/tools/embedded_wasm_render.mjs); web,worker keep the` \
    `# browser live-preview working.` \
    --passL:"-sENVIRONMENT=web,worker,node" \
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
    `# IndexedDB-backed filesystem for the preview's browser asset folder.` \
    --passL:"-lidbfs.js" \
    src/wasm/wasm_main.nim

mkdir -p "$OUT_DIR"
cp "$BUILD_DIR/frameos.js" "$BUILD_DIR/frameos.wasm" "$OUT_DIR/"
if [[ -f "$SCRIPT_DIR/wasm/preview-worker.js" ]]; then
    cp "$SCRIPT_DIR/wasm/preview-worker.js" "$OUT_DIR/"
fi

echo "wasm bundle ready in $OUT_DIR:"
ls -la "$OUT_DIR"
