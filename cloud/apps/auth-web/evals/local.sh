#!/usr/bin/env bash
# The AI evals on this machine in one command (evals/README.md): a cloud dev
# server of this checkout on its own port (EVAL_PORT, 3107: never the 3000 a
# `pnpm dev` holds, so a running dev session is left alone), the evals against
# it, the comparison with the newest earlier report, and the server stopped.
#
#   OPENAI_API_KEY=sk-... cloud/apps/auth-web/evals/local.sh                 # the suite, compared
#   OPENAI_API_KEY=sk-... cloud/apps/auth-web/evals/local.sh --only create-word-clock
#   cloud/apps/auth-web/evals/local.sh --smoke   # no key: the server, the store, one render
#
# It needs the local database holding the store scenes (DATABASE_URL, default
# the dev Postgres on 55432; fill it once with `DATABASE_URL=...
# node scripts/import-store-scenes.mjs` while a dev server runs). The key may
# also live in cloud/.env.local (evals/run.ts reads it). `--compare` is added
# unless you pass one: the newest evals/results/**/report.json there is.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${EVAL_PORT:-3107}"
URL="http://localhost:$PORT"
export CLOUD_URL="$URL"
export DATABASE_URL="${DATABASE_URL:-postgres://frameos_cloud@127.0.0.1:55432/frameos_cloud}"
# A dev server needs these; .env.local wins where it sets them.
export SESSION_SECRET="${SESSION_SECRET:-frameos-evals-local-session-secret-0123456789}"
export FRAMEOS_CLOUD_APP_URL="${FRAMEOS_CLOUD_APP_URL:-$URL}"
export FRAMEOS_ACCOUNT_APP_URL="${FRAMEOS_ACCOUNT_APP_URL:-$URL}"
export FRAMEOS_SCENES_APP_URL="${FRAMEOS_SCENES_APP_URL:-$URL}"

smoke=0
if [ "${1:-}" = "--smoke" ]; then
  smoke=1
  shift
fi
if [ "$smoke" = 0 ] && [ -z "${OPENAI_API_KEY:-}" ] && ! grep -qs '^OPENAI_API_KEY=.' "$APP/../../.env.local" "$APP/.env.local"; then
  echo "OPENAI_API_KEY is not set (nor in cloud/.env.local): set it, or run --smoke" >&2
  exit 2
fi

cd "$APP"
log="$(mktemp "${TMPDIR:-/tmp}/frameos-evals-dev.XXXXXX")"
echo "dev server on $URL (log: $log)"
pnpm run predev >"$log" 2>&1
PORT="$PORT" pnpm exec next dev --turbopack --port "$PORT" >>"$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT
for _ in $(seq 1 180); do
  if curl -sf -o /dev/null "$URL/api/store/browse?limit=1"; then break; fi
  if ! kill -0 "$server" 2>/dev/null; then
    echo "the dev server stopped: see $log" >&2
    exit 1
  fi
  sleep 2
done
curl -sf -o /dev/null "$URL/api/store/browse?limit=1" || { echo "no answer from $URL: see $log" >&2; exit 1; }

if [ "$smoke" = 1 ]; then
  slug="$(curl -sf "$URL/api/store/browse?limit=1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const x=(j.scenes||j.items||j)[0];console.log(x.slug)})')"
  echo "store answers; rendering $slug"
  pnpm exec tsx evals/render-scene.ts "$slug" --out "${TMPDIR:-/tmp}/frameos-evals-smoke.png"
  exit 0
fi

args=("$@")
if [[ " ${args[*]:-} " != *" --compare "* ]]; then
  previous="$(find evals/results -name report.json -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)"
  if [ -n "$previous" ]; then
    echo "comparing with $previous"
    args+=(--compare "$previous")
  fi
fi
pnpm exec tsx evals/run.ts "${args[@]}"
