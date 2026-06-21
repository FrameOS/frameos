#!/usr/bin/env bash
# Build a FrameOS Pico UF2 and check the 4MB flash budget.
#
# CI runs this inside the FrameOS Docker image so the packaged Pico SDK and ARM
# GCC toolchain are exercised, not a developer's host setup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLATFORM="${FRAMEOS_PICO_PLATFORM:-pico2}"
case "$PLATFORM" in
    pico2)
        DEFAULT_BOARD="pico2"
        ;;
    pico2w|pico2-w|pico-2-w)
        PLATFORM="pico2w"
        DEFAULT_BOARD="pico2_w"
        ;;
    *)
        echo "Unsupported FRAMEOS_PICO_PLATFORM: $PLATFORM" >&2
        exit 1
        ;;
esac

BOARD="${FRAMEOS_PICO_BOARD:-$DEFAULT_BOARD}"
BUILD_NAME="${FRAMEOS_PICO_BUILD_DIR:-build-ci-$PLATFORM}"
if [[ "$BUILD_NAME" = /* ]]; then
    BUILD_DIR="$BUILD_NAME"
else
    BUILD_DIR="$SCRIPT_DIR/$BUILD_NAME"
fi

: "${PICO_SDK_PATH:=/opt/pico/pico-sdk}"

if [[ ! -f "$PICO_SDK_PATH/external/pico_sdk_import.cmake" ]]; then
    echo "PICO_SDK_PATH does not point at the Pico SDK: $PICO_SDK_PATH" >&2
    exit 1
fi

if ! command -v cmake >/dev/null; then
    echo "cmake not found on PATH" >&2
    exit 1
fi

if ! command -v arm-none-eabi-gcc >/dev/null; then
    echo "arm-none-eabi-gcc not found on PATH" >&2
    exit 1
fi

if ! command -v arm-none-eabi-g++ >/dev/null; then
    echo "arm-none-eabi-g++ not found on PATH" >&2
    exit 1
fi

if ! printf '#include <cstdlib>\n' | arm-none-eabi-g++ -x c++ -std=gnu++17 -E - >/dev/null 2>&1; then
    echo "ARM C++ standard library headers not found; install libstdc++-arm-none-eabi-dev/newlib" >&2
    exit 1
fi

if [[ -d "$BUILD_DIR" && "${FRAMEOS_PICO_REUSE_BUILD:-0}" != "1" ]]; then
    cat >&2 <<EOF
Refusing to reuse existing Pico build directory:
  $BUILD_DIR
Use a fresh FRAMEOS_PICO_BUILD_DIR or set FRAMEOS_PICO_REUSE_BUILD=1.
EOF
    exit 1
fi

CMAKE_GENERATOR_ARGS=()
if command -v ninja >/dev/null; then
    CMAKE_GENERATOR_ARGS=(-G Ninja)
fi

echo "Building FrameOS Pico firmware for $PLATFORM ($BOARD)"
cmake -S "$SCRIPT_DIR" -B "$BUILD_DIR" \
    "${CMAKE_GENERATOR_ARGS[@]}" \
    -DPICO_SDK_PATH="$PICO_SDK_PATH" \
    -DPICO_BOARD="$BOARD"
cmake --build "$BUILD_DIR" --parallel

UF2="$BUILD_DIR/frameos_pico2.uf2"
ELF="$BUILD_DIR/frameos_pico2.elf"
BIN="$BUILD_DIR/frameos_pico2.bin"

file_size() {
    local path="$1"
    local size
    if size="$(stat -c '%s' "$path" 2>/dev/null)"; then
        echo "$size"
    else
        stat -f '%z' "$path"
    fi
}

for output in "$UF2" "$ELF" "$BIN"; do
    if [[ ! -s "$output" ]]; then
        echo "Missing or empty build output: $output" >&2
        exit 1
    fi
done

FLASH_BYTES=$((4 * 1024 * 1024))
BIN_BYTES="$(file_size "$BIN")"
UF2_BYTES="$(file_size "$UF2")"

if (( BIN_BYTES > FLASH_BYTES )); then
    echo "Pico firmware binary is too large: $BIN_BYTES bytes > $FLASH_BYTES byte flash" >&2
    exit 1
fi

if command -v arm-none-eabi-size >/dev/null; then
    arm-none-eabi-size "$ELF"
fi

echo "Pico binary: $BIN_BYTES bytes ($((FLASH_BYTES - BIN_BYTES)) bytes free in 4MB flash)"
echo "Pico UF2: $UF2_BYTES bytes"
