#!/bin/bash
# The layout and built-in passes: run_extra.sh <wasm-dir> <out-dir>
set -u
WASM="$1"; OUT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
{
  for p in e1002 e1002-portrait e1003 e1003-portrait e1004 e1004-landscape; do
    echo "$p|--layout|reTerminal layout"
    echo "$p|--layout|reTerminal layout|--builtins|1"
  done
  for p in sticky sticky-landscape; do
    echo "$p|--layout|reTerminal Sticky layout"
    echo "$p|--layout|reTerminal Sticky layout|--builtins|1"
  done
  python3 -c 'import json,sys; print("\n".join(k + "|--builtins|1" for k in json.load(open(sys.argv[1]))))' "$HERE/panels.json"
} | while IFS= read -r line; do
  IFS='|' read -r -a parts <<< "$line"
  printf '%s\0' "${parts[@]}" > /dev/null
  echo "$line"
done | xargs -P "${JOBS:-8}" -I{} bash -c '
  IFS="|" read -r -a a <<< "{}"
  p="${a[0]}"; rest=("${a[@]:1}")
  tag=$(echo "{}" | tr -c "a-zA-Z0-9\n" "_")
  node "'"$HERE"'/ux.mjs" --wasm "'"$WASM"'" --panel "$p" --out "'"$OUT"'" "${rest[@]}" > "'"$OUT"'/$tag.log" 2>&1; echo "{} done"'
