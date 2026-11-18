#!/usr/bin/env bash
# How far FrameOS is from compiling with Nimony (Nim 3), measured
# (docs/nimony.md). Builds a pinned Nimony, asks it to check the ESP32
# runtime's own modules and the packages under them, and compiles one probe
# program with both compilers for the ESP32 target.
#
#   tools/nimony/probe.sh                # report in frameos/build/nimony-probe/report.md
#   NIMONY_DIR=~/src/nimony tools/nimony/probe.sh   # an existing checkout, built
#   NIMONY_XTENSA_IMAGE=frameos-esp32-ci-local:latest tools/nimony/probe.sh
#                                        # also size the probe with the IDF's Xtensa GCC
#
# Nothing here changes how FrameOS builds: the probe reads the tree and writes
# under frameos/build/ only.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRAMEOS="$ROOT/frameos"
# The Nimony commit this was measured on (2026-11-17, "0.6.3 development").
NIMONY_COMMIT="${NIMONY_COMMIT:-3693daa2be7cfceada99e06fb54f7dd0d35d08a4}"
NIMONY_DIR="${NIMONY_DIR:-$FRAMEOS/build/nimony}"
WORK="${NIMONY_WORK:-$FRAMEOS/build/nimony-probe}"
REPORT="$WORK/report.md"
mkdir -p "$WORK/tmp" "$WORK/logs"
# Nimony writes its temporaries next to its caches; keep them off a small /tmp.
export TMPDIR="$WORK/tmp"

if [[ ! -x "$NIMONY_DIR/bin/nimony" ]]; then
    if [[ ! -d "$NIMONY_DIR/.git" ]]; then
        git clone --quiet https://github.com/nim-lang/nimony.git "$NIMONY_DIR" || exit 1
    fi
    git -C "$NIMONY_DIR" fetch --quiet origin "$NIMONY_COMMIT" 2>/dev/null || true
    git -C "$NIMONY_DIR" checkout --quiet "$NIMONY_COMMIT" || exit 1
    echo "building Nimony $NIMONY_COMMIT (several minutes)"
    (cd "$NIMONY_DIR" && nim c --hints:off -r src/hastur/hastur build all) > "$WORK/logs/nimony-build.log" 2>&1 \
        || { tail -30 "$WORK/logs/nimony-build.log"; exit 1; }
fi
NIMONY="$NIMONY_DIR/bin/nimony"

python3 "$FRAMEOS/tools/nimble_paths.py" >/dev/null
# The paths Nim 2 builds with: the runtime, the in-tree pixie, nimble.lock's packages.
paths=(-p:"$FRAMEOS/src" -p:"$FRAMEOS/pixie/src")
while IFS= read -r p; do paths+=(-p:"$p"); done < <(sed -n 's/^--path:"\(.*\)"$/\1/p' "$FRAMEOS/nimble.paths")
package_dir() { sed -n "s/^--path:\"\(.*\/$1-[^\"]*\)\"$/\1/p" "$FRAMEOS/nimble.paths" | head -1; }
FRAMEOS_ROOT_DIR="$FRAMEOS" python3 "$FRAMEOS/tools/makeapploaders.py" >/dev/null

# What the ESP32 build is (embedded/esp32/build_nim.sh), as far as Nimony has
# the same switches.
esp=(--cpu:esp --os:freertos --bits:32 -d:release -d:frameosEmbedded -d:pixieNoPpm)

# The host is checked too: Nimony's stdlib has no FreeRTOS ABI yet, so on the
# ESP32 target it stops before the packages, and the host shows what their
# own source needs. pixieNoSimd: the ESP32 has no SSE/NEON paths either.
host=(-d:release -d:frameosEmbedded -d:pixieNoPpm -d:pixieNoSimd)

{
    echo "# Nimony probe"
    echo
    echo "Nimony \`$(git -C "$NIMONY_DIR" rev-parse --short HEAD)\` ($("$NIMONY" --version 2>&1 | head -1 | sed 's/.*Version //')),"
    echo "FrameOS \`$(git -C "$ROOT" rev-parse --short HEAD)\`, $(date -u +%Y-%m-%d)."
} > "$REPORT"

check() {
    local target="$1" label="$2" file="$3"
    local -a flags
    if [[ "$target" == esp32 ]]; then flags=("${esp[@]}"); else flags=("${host[@]}"); fi
    local log="$WORK/logs/check-$target-$(echo "$label" | tr '/ ()' '____').txt"
    (cd "$FRAMEOS" && timeout 900 "$NIMONY" check "${flags[@]}" --nimcache:"$WORK/nimcache-$target" "${paths[@]}" "$file") > "$log" 2>&1
    local status=$?
    local errors
    errors=$(grep -c 'Error' "$log")
    local first
    first=$(grep 'Error' "$log" | sed -E "s#$HOME#~#g; s#.*/(pkgs2|frameos|lib)/#\1/#" \
        | sed -E 's#pkgs2/([a-z]+)-[0-9.]+-[0-9a-f]+/#\1: #' | cut -c1-140 | head -3 | sed 's/|/\\|/g' | paste -sd '~' | sed 's/~/<br>/g')
    local result="fails"
    [[ $status -eq 0 ]] && result="**compiles**"
    echo "| \`$label\` | $result | $errors | $first |" >> "$REPORT"
    echo "check $target $label: $result ($errors errors)"
}

for target in host esp32; do
    {
        echo
        if [[ "$target" == esp32 ]]; then
            echo "## \`nimony check\` for the ESP32 (\`${esp[*]}\`)"
        else
            echo "## \`nimony check\` on this host (\`${host[*]}\`)"
        fi
        echo
        echo "| Module | Result | Errors | First errors |"
        echo "|---|---|---:|---|"
    } >> "$REPORT"
    # The packages under the runtime, bottom first, then FrameOS's own
    # modules: leaves with only the stdlib below them, the core types, the
    # image's root.
    for package in vmath bumpy chroma crunchy zippy flatty jsony; do
        dir=$(package_dir "$package")
        [[ -n "$dir" ]] && check "$target" "$package" "$dir/$package.nim"
    done
    check "$target" "pixie (in tree)" "pixie/src/pixie.nim"
    for module in src/frameos/panel_shape.nim src/frameos/ids.nim src/frameos/hal/entropy.nim \
        src/embedded/fos_table_probe.nim src/frameos/js_runtime/pixel_ops.nim \
        src/frameos/scene_code_hooks.nim src/frameos/types.nim; do
        check "$target" "$module" "$module"
    done
    # The image's root imports the generated asset modules (tools/prepare_assets.py,
    # which builds the frame's web bundle with pnpm).
    if [[ -f "$FRAMEOS/src/assets/fonts.nim" ]]; then
        check "$target" "src/embedded/embedded_main.nim" "src/embedded/embedded_main.nim"
    else
        echo "| \`src/embedded/embedded_main.nim\` | skipped | | no generated assets (tools/prepare_assets.py) |" >> "$REPORT"
    fi
done

# The probe program: same source, both compilers, same answer on this host,
# then the C each writes for the ESP32.
probe="$ROOT/tools/nimony/probes/size_probe.nim"
nim2_out=$(nim c --hints:off -r --nimcache:"$WORK/n2-host" -o:"$WORK/size_probe_nim2" "$probe" 2>&1 | tail -1)
nimony_out=$("$NIMONY" c -r --nimcache:"$WORK/ny-host" "$probe" 2>&1 | tail -1)
rm -rf "$WORK/n2-esp" "$WORK/ny-esp"
nim c --hints:off --compileOnly --os:freertos --cpu:esp --mm:orc --threads:off --exceptions:goto \
    --noMain --opt:size -d:release -d:useMalloc -d:noSignalHandler --nimcache:"$WORK/n2-esp" "$probe" > "$WORK/logs/n2-esp.txt" 2>&1
cp "$(nim --hints:off dump --dump.format:json dummy 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["libpath"])')/nimbase.h" "$WORK/n2-esp/"
# -d:useLibc: Nimony's allocator otherwise maps pages with mmap, which ESP-IDF
# has not, and its malloc-backed page path (-d:nimAllocPagesViaMalloc) does not
# compile; --mm:orc does not compile either, so this is the default atomicArc.
# The C compile at the end fails on this host (32-bit pointers); the C is what
# is wanted.
"$NIMONY" c -d:release --opt:size --cpu:esp --os:freertos --bits:32 -d:useLibc --app:staticlib \
    --nimcache:"$WORK/ny-esp" "$probe" > "$WORK/logs/ny-esp.txt" 2>&1
ny_c_dir=$(dirname "$(find "$WORK/ny-esp" -name 'siz*.c' | head -1)")

{
    echo
    echo "## The probe program (\`tools/nimony/probes/size_probe.nim\`)"
    echo
    echo "- Nim 2 prints \`$nim2_out\`, Nimony prints \`$nimony_out\`."
    echo "- C for the ESP32: Nim 2 wrote $(ls "$WORK"/n2-esp/*.c 2>/dev/null | wc -l) files ($(cat "$WORK"/n2-esp/*.c | wc -l) lines), Nimony $(ls "$ny_c_dir"/*.c 2>/dev/null | wc -l) files ($(cat "$ny_c_dir"/*.c 2>/dev/null | wc -l) lines)."
} >> "$REPORT"

if [[ -n "${NIMONY_XTENSA_IMAGE:-}" ]]; then
    rel() { realpath --relative-to="$ROOT" "$1"; }
    {
        echo
        echo "### Linked for the ESP32-S3 (\`tools/nimony/xtensa_size.sh\`, root \`fos_probe_run\`)"
        echo
        echo '```'
        docker run --rm -v "$ROOT":/w -w /w "$NIMONY_XTENSA_IMAGE" bash -c \
            "bash tools/nimony/xtensa_size.sh $(rel "$WORK/n2-esp") fos_probe_run; bash tools/nimony/xtensa_size.sh $(rel "$ny_c_dir") fos_probe_run" 2>/dev/null
        echo '```'
    } >> "$REPORT"
fi

echo
echo "report: $REPORT"
[[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && cat "$REPORT" >> "$GITHUB_STEP_SUMMARY"
exit 0
