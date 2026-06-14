#!/usr/bin/env bash
# Build the full ESP32 firmware image and check the flash layout we ship.
#
# CI runs this inside the FrameOS Docker image so the packaged native ESP-IDF
# and Nim toolchains are exercised, not a developer's host setup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PANEL="${FRAMEOS_SELECTED_PANEL:-EPD_7in5_V2}"
BUILD_NAME="${FRAMEOS_ESP32_BUILD_DIR:-build-ci}"
if [[ "$BUILD_NAME" = /* ]]; then
    BUILD_DIR="$BUILD_NAME"
else
    BUILD_DIR="$SCRIPT_DIR/$BUILD_NAME"
fi

SDKCONFIG_PATH="${FRAMEOS_ESP32_SDKCONFIG:-$BUILD_DIR/sdkconfig}"
QEMU_SMOKE="${FRAMEOS_ESP32_QEMU:-0}"
QEMU_TIMEOUT_SECONDS="${FRAMEOS_ESP32_QEMU_TIMEOUT_SECONDS:-60}"
SDKCONFIG_DEFAULTS="${FRAMEOS_ESP32_SDKCONFIG_DEFAULTS:-$SCRIPT_DIR/sdkconfig.defaults}"
if [[ "$QEMU_SMOKE" == "1" && -z "${FRAMEOS_ESP32_SDKCONFIG_DEFAULTS:-}" ]]; then
    SDKCONFIG_DEFAULTS="$SCRIPT_DIR/sdkconfig.defaults;$SCRIPT_DIR/sdkconfig.qemu.defaults"
fi

: "${IDF_PATH:=/opt/esp/esp-idf}"
NIM_BIN_DIR="${FRAMEOS_NIM_BIN_DIR:-/opt/nim/bin}"

if [[ -d "$NIM_BIN_DIR" ]]; then
    export PATH="$NIM_BIN_DIR:$PATH"
fi

if [[ ! -f "$IDF_PATH/export.sh" ]]; then
    echo "IDF_PATH does not point at ESP-IDF: $IDF_PATH" >&2
    exit 1
fi

if [[ -e "$SDKCONFIG_PATH" && "${FRAMEOS_ESP32_REUSE_SDKCONFIG:-0}" != "1" ]]; then
    cat >&2 <<EOF
Refusing to reuse existing generated sdkconfig:
  $SDKCONFIG_PATH
Use a fresh FRAMEOS_ESP32_BUILD_DIR or set FRAMEOS_ESP32_REUSE_SDKCONFIG=1.
EOF
    exit 1
fi

if [[ -d "$BUILD_DIR" && "${FRAMEOS_ESP32_REUSE_BUILD:-0}" != "1" ]]; then
    cat >&2 <<EOF
Refusing to reuse existing ESP32 build directory:
  $BUILD_DIR
Use a fresh FRAMEOS_ESP32_BUILD_DIR or set FRAMEOS_ESP32_REUSE_BUILD=1.
EOF
    exit 1
fi

# shellcheck source=/dev/null
. "$IDF_PATH/export.sh" >/dev/null
if [[ -d "$NIM_BIN_DIR" ]]; then
    export PATH="$NIM_BIN_DIR:$PATH"
fi

mkdir -p "$BUILD_DIR"
cd "$SCRIPT_DIR"

export FRAMEOS_SELECTED_PANEL="$PANEL"
echo "Building FrameOS ESP32 firmware for panel $FRAMEOS_SELECTED_PANEL"
./build_nim.sh
idf.py -B "$BUILD_DIR" \
    -D SDKCONFIG="$SDKCONFIG_PATH" \
    -D SDKCONFIG_DEFAULTS="$SDKCONFIG_DEFAULTS" \
    reconfigure build merge-bin

require_line() {
    local pattern="$1"
    local file="$2"
    if ! grep -Eq "$pattern" "$file"; then
        echo "Missing expected pattern in $file: $pattern" >&2
        exit 1
    fi
}

file_size() {
    local path="$1"
    local size
    if size="$(stat -c '%s' "$path" 2>/dev/null)"; then
        echo "$size"
    else
        stat -f '%z' "$path"
    fi
}

require_line '^CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y$' "$SDKCONFIG_PATH"
require_line '^CONFIG_ESPTOOLPY_FLASHSIZE="8MB"$' "$SDKCONFIG_PATH"
require_line '^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"$' "$SDKCONFIG_PATH"
if [[ "$QEMU_SMOKE" == "1" ]]; then
    require_line '^CONFIG_ESP_CONSOLE_UART_DEFAULT=y$' "$SDKCONFIG_PATH"
    require_line '^CONFIG_LOG_DEFAULT_LEVEL_INFO=y$' "$SDKCONFIG_PATH"
    require_line '^# CONFIG_SPIRAM is not set$' "$SDKCONFIG_PATH"
fi

PARTITION_DUMP="$BUILD_DIR/partition-table.generated.csv"
python3 "$IDF_PATH/components/partition_table/gen_esp32part.py" \
    "$BUILD_DIR/partition_table/partition-table.bin" > "$PARTITION_DUMP"

require_line '^otadata,data,ota,0xd000,8K,' "$PARTITION_DUMP"
require_line '^ota_0,app,ota_0,0x10000,3520K,' "$PARTITION_DUMP"
require_line '^ota_1,app,ota_1,0x380000,3520K,' "$PARTITION_DUMP"
require_line '^state,data,spiffs,0x6f0000,1M,' "$PARTITION_DUMP"

APP_BIN="$BUILD_DIR/frameos_esp32.bin"
MERGED_BIN="$BUILD_DIR/merged-binary.bin"
BOOTLOADER_BIN="$BUILD_DIR/bootloader/bootloader.bin"
PARTITION_BIN="$BUILD_DIR/partition_table/partition-table.bin"

APP_SLOT_BYTES=$((3520 * 1024))
FLASH_BYTES=$((8 * 1024 * 1024))

APP_BYTES="$(file_size "$APP_BIN")"
MERGED_BYTES="$(file_size "$MERGED_BIN")"
BOOTLOADER_BYTES="$(file_size "$BOOTLOADER_BIN")"
PARTITION_BYTES="$(file_size "$PARTITION_BIN")"

if (( APP_BYTES > APP_SLOT_BYTES )); then
    echo "App binary is too large: $APP_BYTES bytes > $APP_SLOT_BYTES byte OTA slot" >&2
    exit 1
fi

if (( MERGED_BYTES > FLASH_BYTES )); then
    echo "Merged image is too large: $MERGED_BYTES bytes > $FLASH_BYTES byte flash" >&2
    exit 1
fi

echo "ESP32 app binary: $APP_BYTES bytes ($((APP_SLOT_BYTES - APP_BYTES)) bytes free in OTA slot)"
echo "ESP32 merged image: $MERGED_BYTES bytes"
echo "ESP32 bootloader: $BOOTLOADER_BYTES bytes"
echo "ESP32 partition table: $PARTITION_BYTES bytes"

if [[ "$QEMU_SMOKE" != "1" ]]; then
    exit 0
fi

if ! command -v qemu-system-xtensa >/dev/null; then
    echo "qemu-system-xtensa not found on PATH; install ESP-IDF qemu-xtensa" >&2
    exit 1
fi

if ! command -v timeout >/dev/null; then
    echo "timeout not found on PATH; QEMU smoke test needs GNU coreutils timeout" >&2
    exit 1
fi

QEMU_LOG="$BUILD_DIR/qemu-smoke.log"
set +e
timeout "${QEMU_TIMEOUT_SECONDS}" idf.py -B "$BUILD_DIR" qemu > "$QEMU_LOG" 2>&1
QEMU_STATUS=$?
set -e

cat "$QEMU_LOG"
if [[ "$QEMU_STATUS" != "0" && "$QEMU_STATUS" != "124" ]]; then
    echo "QEMU exited with unexpected status $QEMU_STATUS" >&2
    exit "$QEMU_STATUS"
fi

if grep -Eq 'Guru Meditation|panic_abort|abort\(\)|Backtrace:' "$QEMU_LOG"; then
    echo "QEMU boot log contains a panic or abort" >&2
    exit 1
fi

require_line 'Loaded app from partition at offset 0x10000' "$QEMU_LOG"
require_line 'cpu_start: Multicore app|Project name:[[:space:]]+frameos_esp32' "$QEMU_LOG"
echo "ESP32 QEMU smoke loaded ota_0 and reached app startup"
