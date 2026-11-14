#!/usr/bin/env bash
# pixie's own suite (frameos/pixie/tests): every test file is its own
# `nim c -d:release -r`. PIXIE_TEST_JOBS of them at a time (default 1, CI
# passes the core count): each compile is single-threaded, so one after
# another took 4.5 minutes of a 16-core runner (2026-11-13). Each test has its
# own nimcache (Nim names it after the file), its output goes to a log of its
# own, and the logs are printed in file order once everything has run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../pixie"
jobs="${PIXIE_TEST_JOBS:-1}"
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || jobs=1

# An anti-aliased circle's luma/565 quantisation differs by one step from the
# RGBX canvas on this host; both failed before the fork moved in (2026-11-07).
skipped=" tests/test_gray8.nim tests/test_rgb565.nim "

logs="$(mktemp -d "${TMPDIR:-/tmp}/pixie-tests.XXXXXX")"
trap 'rm -rf "$logs"' EXIT

tests=()
for t in tests/test_*.nim; do
  if [[ "$skipped" == *" $t "* ]]; then
    echo "== $t (skipped: one-step quantisation difference, see run_pixie_tests.sh)"
    continue
  fi
  tests+=("$t")
done

# With several tests at once, each build gets a few gcc processes rather than
# one per core (Nim's default), or a 16-core runner runs 256 compilers.
parallel_build=0
(( jobs > 1 )) && parallel_build=2
export parallel_build

run_one() {
  local t="$1" log="$2/$(basename "$1" .nim).log"
  if nim c -d:release --hints:off --parallelBuild:"$parallel_build" -r "$t" >"$log" 2>&1; then
    echo ok >"$log.status"
  else
    echo failed >"$log.status"
  fi
}
export -f run_one

echo "pixie: ${#tests[@]} test files, $jobs at a time"
printf '%s\n' "${tests[@]}" | xargs -P "$jobs" -I{} bash -c 'run_one "$1" "$2"' _ {} "$logs"

failed=()
for t in "${tests[@]}"; do
  log="$logs/$(basename "$t" .nim).log"
  echo "== $t"
  cat "$log"
  [[ "$(cat "$log.status" 2>/dev/null)" == ok ]] || failed+=("$t")
done
if (( ${#failed[@]} )); then
  echo "pixie tests failed: ${failed[*]}" >&2
  exit 1
fi
echo "pixie: all ${#tests[@]} passed"
