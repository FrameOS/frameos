#!/bin/bash
# Run the UX bench on every virtual panel in parallel: run_all.sh <wasm-dir> <out-dir> [extra ux.mjs args]
set -u
WASM="$1"; OUT="$2"; shift 2
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))))' "$HERE/panels.json" |
  xargs -P "${JOBS:-10}" -I{} sh -c "node '$HERE/ux.mjs' --wasm '$WASM' --panel {} --out '$OUT' $* > '$OUT/{}.log' 2>&1; echo {} done"
