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
  local bin="/tmp/frameos-test-timeout-diagnosis"
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

for test_file in "${tests[@]}"; do
  echo "==> ${test_file}"
  set +e
  run_testament "$test_file"
  status=$?
  set -e
  if (( status != 0 )); then
    if (( status == 124 )); then
      echo "Timed out after ${test_timeout_seconds}s: ${test_file}" >&2
      set +e
      diagnose_timeout "$test_file"
      set -e
    fi
    exit "$status"
  fi
done
