#!/usr/bin/env bash
# pixie's fuzzers (frameos/pixie/tests/fuzz_*.nim), with the checks ON.
#
# A release build of pixie turns its own checks off (`{.push checks: off.}`
# under `when defined(release)`, in the decoders, the font readers and the
# rasterizer), and those modules read bytes from wherever a scene's URL or a
# card's font came from. So each fuzzer is built here WITHOUT -d:release, which
# leaves every bound, range and overflow check Nim has in place, and under
# AddressSanitizer over -d:useMalloc, which sees what Nim's checks cannot: the
# readers that go through a bare pointer (the streaming inflater, the two font
# readers that read where the bytes lie).
#
#   make fuzz-pixie                                every fuzzer, 60 s each
#   PIXIE_FUZZ_SECONDS=600 make fuzz-pixie         longer
#   PIXIE_FUZZERS="inflate png" make fuzz-pixie    these ones
#   PIXIE_FUZZ_JOBS=8 make fuzz-pixie              that many at a time (default 1)
#   PIXIE_FUZZ_LOGS=<dir> make fuzz-pixie          keep every log there
#   PIXIE_FUZZ_SEED=<n> PIXIE_FUZZERS=inflate make fuzz-pixie
#       a run again: fuzz_inflate, fuzz_file_font and fuzz_indexed_font print
#       their seed first. The older fuzzers print each round's file, place and
#       value instead, which is the input.
#   PIXIE_FUZZ_DEFINES="-d:pixieFuzzSizedOverrun" ...   see "open findings"
#
# A fuzzer passes by finishing its rounds or by its time running out. Anything
# else is a crash: a Defect (which a release would not raise: the check is
# off there), a sanitizer report, a round that never ends (tests/fuzzing.nim
# `fuzzRound`). The end of its log is printed; the last round it names is the
# input, and the whole log is in PIXIE_FUZZ_LOGS.
#
# Open findings. A fuzzer that fails is no use as a check, so what these have
# found and nobody has fixed yet is fenced off, in the open:
#   - `open` below: fuzzers left out of the default run, with what they found.
#     Naming one in PIXIE_FUZZERS runs it.
#   - fences inside the fuzzers (`grep -n 'still open' tests/`, none today),
#     each a const that a -d: flag turns off: one input shape is not given, or
#     one Defect is not counted, and the rest of the fuzzer runs.
# Take a name off the list, or a fence out, in the change that fixes it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../pixie"

seconds="${PIXIE_FUZZ_SECONDS:-60}"
jobs="${PIXIE_FUZZ_JOBS:-1}"
[[ "$seconds" =~ ^[1-9][0-9]*$ ]] || { echo "PIXIE_FUZZ_SECONDS must be a number of seconds" >&2; exit 2; }
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || jobs=1

# None today (the CFF charstring reader's empty stack, fixed 2026-11-24, was
# the last: tests/test_cff_charstrings.nim).
open=" "
# Not fuzzers of a reader: drawing loops that need -d:pixieLeakCheck.
never=" leaks leaks2 leaks3 "

names=()
if [ -n "${PIXIE_FUZZERS:-}" ]; then
  for name in $PIXIE_FUZZERS; do
    [ -f "tests/fuzz_$name.nim" ] || { echo "no tests/fuzz_$name.nim" >&2; exit 2; }
    names+=("$name")
  done
else
  for file in tests/fuzz_*.nim; do
    name="$(basename "$file" .nim)"
    name="${name#fuzz_}"
    [[ "$never" == *" $name "* ]] && continue
    if [[ "$open" == *" $name "* ]]; then
      echo "== fuzz_$name: not run, it has an open finding (see the top of this script)"
      continue
    fi
    names+=("$name")
  done
fi
[ "${#names[@]}" -gt 0 ] || { echo "no fuzzers to run" >&2; exit 2; }

build="${PIXIE_FUZZ_BUILD:-$(cd .. && pwd)/build/pixie-fuzz}"
mkdir -p "$build"
if [ -n "${PIXIE_FUZZ_LOGS:-}" ]; then
  mkdir -p "$PIXIE_FUZZ_LOGS"
  logs="$(cd "$PIXIE_FUZZ_LOGS" && pwd)"
else
  logs="$(mktemp -d "${TMPDIR:-/tmp}/pixie-fuzz.XXXXXX")"
fi
# The font fuzzers write the file they broke here.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/pixie-fuzz-files.XXXXXX")"
trap 'rm -rf "$scratch"; [ -n "${PIXIE_FUZZ_LOGS:-}" ] || rm -rf "$logs"' EXIT

parallel_build=0
(( jobs > 1 )) && parallel_build=2
# Leaks are not what is looked for (and a fuzzer stopped by its clock frees
# nothing). A reader that takes 2 GB for a broken file is.
export ASAN_OPTIONS="detect_leaks=0:hard_rss_limit_mb=2048${ASAN_OPTIONS:+:$ASAN_OPTIONS}"
export build logs scratch seconds parallel_build
export PIXIE_FUZZ_DEFINES="${PIXIE_FUZZ_DEFINES:-}"

run_one() {
  local name="$1"
  local bin="$build/fuzz_$name" log="$logs/fuzz_$name.log"
  # No -d:release: that is the point. --opt:speed keeps the rounds coming,
  # the traces say where, and the frame pointers are for the sanitizer's.
  # shellcheck disable=SC2086  # PIXIE_FUZZ_DEFINES is a list of flags
  if ! nim c --hints:off --warnings:off --opt:speed --stackTrace:on --lineTrace:on \
    -d:useMalloc --debugger:native \
    --passC:-fsanitize=address --passC:-fno-omit-frame-pointer --passL:-fsanitize=address \
    --parallelBuild:"$parallel_build" $PIXIE_FUZZ_DEFINES \
    --nimcache:"$build/cache_$name" --out:"$bin" "tests/fuzz_$name.nim" >"$log.build" 2>&1; then
    echo "build" >"$log.status"
    return 0
  fi
  local code=0
  TMPDIR="$scratch" timeout "$seconds" "$bin" >"$log" 2>&1 || code=$?
  case "$code" in
    0) echo "ok finished" >"$log.status" ;;
    124) echo "ok time" >"$log.status" ;;
    *) echo "crash $code" >"$log.status" ;;
  esac
}
export -f run_one

echo "pixie: ${#names[@]} fuzzers, ${seconds} s each, $jobs at a time, checks on, AddressSanitizer"
# shellcheck disable=SC2016  # $1 is the inner shell's, on purpose
printf '%s\n' "${names[@]}" | xargs -P "$jobs" -I{} bash -c 'run_one "$1"' _ {}

failed=()
for name in "${names[@]}"; do
  log="$logs/fuzz_$name.log"
  status="$(cat "$log.status" 2>/dev/null || echo "crash ?")"
  lines="$(wc -l <"$log" 2>/dev/null || echo 0)"
  case "$status" in
    "ok finished") echo "== fuzz_$name: ok, all its rounds ($lines log lines)" ;;
    "ok time") echo "== fuzz_$name: ok, ${seconds} s ($lines log lines)" ;;
    build)
      echo "== fuzz_$name: DID NOT BUILD"
      tail -n 40 "$log.build"
      failed+=("$name")
      ;;
    *)
      echo "== fuzz_$name: CRASHED (exit ${status#crash })"
      # The seed, when it prints one, then the end: the last rounds and what
      # stopped it. A sanitizer report is long, so more of the end for those.
      head -n 1 "$log" | grep '^seed ' || true
      if grep -q 'ERROR: AddressSanitizer' "$log"; then
        grep -B 6 -A 45 -m 1 'ERROR: AddressSanitizer' "$log" || true
      else
        tail -n 40 "$log"
      fi
      failed+=("$name")
      ;;
  esac
done

if (( ${#failed[@]} )); then
  echo "pixie fuzzers failed: ${failed[*]}" >&2
  echo "again: PIXIE_FUZZERS=\"${failed[*]}\" make fuzz-pixie (PIXIE_FUZZ_SEED=<the seed above> where one is printed)" >&2
  exit 1
fi
echo "pixie: all ${#names[@]} fuzzers held"
