#!/usr/bin/env bash
# What a directory of generated C costs in an ESP32-S3 image: every *.c in it
# compiled the way the firmware compiles the Nim runtime (-Os, function
# sections, -mlongcalls), linked with --gc-sections from one root, sizes from
# the linked ELF. libc and the IDF stay unresolved (they are in the image
# anyway), so the number is the generated code and its runtime alone.
#
# Runs inside the ESP32 CI image (frameos-esp32-ci-local / esp32-ci):
#   docker run --rm -v "$PWD":/w -w /w frameos-esp32-ci-local:latest \
#     bash tools/nimony/xtensa_size.sh <dir> <root symbol> [extra -I dirs...]
set -euo pipefail

dir="$1"
root="$2"
shift 2
bin=$(ls -d /opt/esp/idf-tools/tools/xtensa-esp-elf/*/xtensa-esp-elf/bin | head -1)
cc="$bin/xtensa-esp32s3-elf-gcc"
size="$bin/xtensa-esp32s3-elf-size"
nm="$bin/xtensa-esp32s3-elf-nm"

out=$(mktemp -d)
includes=(-I"$dir")
for extra in "$@"; do includes+=(-I"$extra"); done

for c in "$dir"/*.c; do
    "$cc" -c -Os -ffunction-sections -fdata-sections -mlongcalls -fwrapv \
        -fno-strict-aliasing -w -Wno-error=incompatible-pointer-types "${includes[@]}" "$c" -o "$out/$(basename "$c").o"
done

"$cc" -nostdlib -nostartfiles -Wl,--gc-sections -Wl,-e,"$root" \
    -Wl,--unresolved-symbols=ignore-all -Wl,--noinhibit-exec \
    "$out"/*.o -o "$out/linked.elf" 2>/dev/null || true

echo "== $dir (root $root)"
"$size" -A "$out/linked.elf" | awk '$1 ~ /^\.(text|rodata|data|literal|bss)/ {print}'
"$size" "$out/linked.elf" | tail -1 | awk '{print "text+data:", $1 + $2}'
echo "-- largest functions and tables"
"$nm" -S --size-sort -r "$out/linked.elf" | awk '$3 ~ /[tTrR]/' | head -12
rm -rf "$out"
