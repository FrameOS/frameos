#!/usr/bin/env bash
set -euo pipefail

total_shards="${FRAMEOS_TEST_TOTAL_SHARDS:-8}"

usage() {
  cat <<EOF
Usage: tools/run_test_shard.sh <1..${total_shards}> [--print]

Runs one deterministic FrameOS Nim test shard from the frameos/ directory.
Every test file under \`src/**/tests/\` is assigned to a shard in a
deterministic pseudo-random (filename hash) order, so adding or removing test
files rebalances automatically. Set FRAMEOS_TEST_TOTAL_SHARDS to change the
shard count (default ${total_shards}).
Pass --print to list the shard contents without running testament.
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 1
fi

shard="$1"
print_only=0

if [[ "${2:-}" == "--print" ]]; then
  print_only=1
elif [[ $# -eq 2 ]]; then
  usage >&2
  exit 1
fi

if ! [[ "$shard" =~ ^[0-9]+$ ]]; then
  usage >&2
  exit 1
fi

shard=$((shard))

if (( shard < 1 || shard > total_shards )); then
  usage >&2
  exit 1
fi

frameos_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$frameos_dir"

discover_tests() {
  find src -type f -name '*.nim' | awk -F/ '$(NF-1) == "tests" && $NF ~ /^test.*\.nim$/ { print }' | sort
}

declare -a tests=()
idx=0
while IFS=$'\t' read -r _hash test_file; do
  if (( idx % total_shards == shard - 1 )); then
    tests+=("$test_file")
  fi
  idx=$((idx + 1))
done < <(
  while IFS= read -r test_file; do
    [[ -z "$test_file" ]] && continue
    hash="$(printf '%s' "$test_file" | cksum | awk '{print $1}')"
    printf '%s\t%s\n' "$hash" "$test_file"
  done < <(discover_tests) | sort -n -k1,1 -k2,2
)

echo "FrameOS Nim test shard ${shard}/${total_shards}: ${#tests[@]} of ${idx} test files"

if (( ${#tests[@]} == 0 )); then
  exit 0
fi

if (( print_only )); then
  printf '%s\n' "${tests[@]}"
  exit 0
fi

test_timeout_seconds="${FRAMEOS_TEST_TIMEOUT_SECONDS:-}"
if [[ -z "$test_timeout_seconds" && "${CI:-}" == "true" ]]; then
  test_timeout_seconds=300
fi

# How many test files to compile+run at once. Each testament invocation is
# one single-threaded Nim compile of most of the tree, so a shard that runs
# them one after another leaves three of a four-core runner idle for five
# minutes. Testament already gives every test its own nimcache dir, and each
# worker below gets a private TMPDIR, so the files cannot trample each other.
# Defaults to the core count on CI and to 1 locally (interleaved output is
# not what you want while debugging one failing test).
test_jobs="${FRAMEOS_TEST_JOBS:-}"
if [[ -z "$test_jobs" ]]; then
  if [[ "${CI:-}" == "true" ]]; then
    test_jobs="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)"
  else
    test_jobs=1
  fi
fi
if ! [[ "$test_jobs" =~ ^[0-9]+$ ]] || (( test_jobs < 1 )); then
  test_jobs=1
fi

run_testament() {
  local test_file="$1"

  if [[ -n "$test_timeout_seconds" ]] && command -v timeout >/dev/null 2>&1; then
    timeout "${test_timeout_seconds}s" testament pattern "./${test_file}" --lineTrace:on
  else
    testament pattern "./${test_file}" --lineTrace:on
  fi
}

diagnose_timeout() {
  # A testament timeout is a single opaque kill: nothing says whether the
  # compiler or the test binary was the thing that hung. Re-run once with the
  # phases split and capped, so the CI log answers that on the machine where
  # it actually happens.
  local test_file="$1"
  local bin
  bin="$(mktemp "${TMPDIR:-/tmp}/frameos-test-timeout-diagnosis.XXXXXX")"
  echo "--- timeout diagnosis: compiling ${test_file} separately (cap ${test_timeout_seconds}s)"
  if ! timeout "${test_timeout_seconds}s" \
      nim c --hints:off -d:testing -o:"$bin" "./${test_file}"; then
    echo "--- timeout diagnosis: the COMPILE phase did not finish"
    return
  fi
  echo "--- timeout diagnosis: compile finished; running the binary (cap 120s)"
  local run_status=0
  timeout 120s "$bin" || run_status=$?
  if (( run_status == 124 )); then
    echo "--- timeout diagnosis: the RUN phase hung"
  else
    echo "--- timeout diagnosis: split run exited with status ${run_status}"
  fi
}

# Runs one test file to completion (plus the timeout diagnosis when needed)
# and returns its status. Output goes to whatever stdout is at the time: the
# terminal when sequential, a per-test log file when parallel.
run_one() {
  local test_file="$1"
  echo "==> ${test_file}"
  local status=0
  run_testament "$test_file" || status=$?
  if (( status == 124 )); then
    echo "Timed out after ${test_timeout_seconds}s: ${test_file}" >&2
    diagnose_timeout "$test_file" || true
  fi
  return "$status"
}

if (( test_jobs == 1 || ${#tests[@]} == 1 )); then
  for test_file in "${tests[@]}"; do
    run_one "$test_file" || exit $?
  done
  exit 0
fi

echo "Running up to ${test_jobs} test files at a time"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/frameos-test-shard.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

# One worker per test file, capped at $test_jobs in flight. Each worker logs
# to its own file and its own TMPDIR (getTempDir() honours it, and several
# tests use fixed names under it); the log is replayed in submission order as
# soon as that test is done, so the CI output reads exactly like the
# sequential run — just with a few tests "already finished" when you get to
# them. The first failure stops the queue from starting anything new, but
# in-flight tests run to completion so their output is not lost.
declare -a pids=() logs=() files=()
running=0
next_to_print=0
overall_status=0

print_ready() {
  # Flush finished tests in order, stopping at the first one still running.
  while (( next_to_print < ${#pids[@]} )); do
    local pid="${pids[$next_to_print]}"
    if kill -0 "$pid" 2>/dev/null; then
      return
    fi
    local status=0
    wait "$pid" || status=$?
    cat "${logs[$next_to_print]}"
    if (( status != 0 && overall_status == 0 )); then
      overall_status="$status"
      echo "FAILED (${status}): ${files[$next_to_print]}" >&2
    fi
    next_to_print=$((next_to_print + 1))
    running=$((running - 1))
  done
}

for test_file in "${tests[@]}"; do
  if (( overall_status != 0 )); then
    break
  fi
  while (( running >= test_jobs )); do
    sleep 0.2
    print_ready
  done
  idx=${#pids[@]}
  log="${work_dir}/${idx}.log"
  tmp="${work_dir}/tmp-${idx}"
  mkdir -p "$tmp"
  (
    export TMPDIR="$tmp"
    run_one "$test_file"
  ) >"$log" 2>&1 &
  pids+=("$!")
  logs+=("$log")
  files+=("$test_file")
  running=$((running + 1))
  print_ready
done

# Drain whatever is still in flight, in order.
while (( next_to_print < ${#pids[@]} )); do
  sleep 0.2
  print_ready
done

exit "$overall_status"
