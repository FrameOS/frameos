#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# Which of the suite's backends this is (tests/backends.ts): 0 is the one a
# local run has always had; CI starts one per Playwright worker.
INSTANCE="${FRONTEND_VISUAL_INSTANCE:-0}"
PORT="${FRONTEND_VISUAL_PORT:-$((8989 + INSTANCE))}"

export DEBUG="${DEBUG:-1}"
export SECRET_KEY="${SECRET_KEY:-frontend-visual-secret}"

mkdir -p "$ROOT/.tmp"

if [ "$INSTANCE" = 0 ]; then
  export DATABASE_URL="${DATABASE_URL:-sqlite:///$ROOT/.tmp/frontend-visual.db}"
  export REDIS_URL="${REDIS_URL:-redis://localhost:6379/15}"
  photos_dir="$ROOT/.tmp/frontend-visual-photos"
else
  # Every further backend gets a database, a photos folder and a Redis SERVER
  # of its own. Not just a Redis database number: the backend fans websocket
  # events out over Redis pub/sub, which ignores the database, so two backends
  # on one server push each other's frame events into each other's pages.
  export DATABASE_URL="sqlite:///$ROOT/.tmp/frontend-visual-$INSTANCE.db"
  redis_port=$((6379 + INSTANCE))
  export REDIS_URL="redis://localhost:$redis_port/15"
  if ! redis-cli -p "$redis_port" ping >/dev/null 2>&1; then
    redis-server --port "$redis_port" --save '' --appendonly no --daemonize yes >/dev/null
    for _ in $(seq 1 50); do redis-cli -p "$redis_port" ping >/dev/null 2>&1 && break; sleep 0.1; done
  fi
  photos_dir="$ROOT/.tmp/frontend-visual-photos-$INSTANCE"
fi

# The Photos library (tests/photos.spec.ts) keeps its bytes on disk next to
# the rows: give it a folder as disposable as the database. Only the default
# is wiped.
if [ -z "${FRAMEOS_PHOTOS_DIR:-}" ] || [ "$INSTANCE" != 0 ]; then
  export FRAMEOS_PHOTOS_DIR="$photos_dir"
  rm -rf "$FRAMEOS_PHOTOS_DIR"
fi

if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "frontend/dist is missing. Run: pnpm --dir frontend run build" >&2
  exit 1
fi

PYTHONPATH="$ROOT/backend" python "$ROOT/e2e/frontend-visual/scripts/seed_backend.py"

cd "$ROOT/backend"
exec python -m uvicorn app.fastapi:app --host 127.0.0.1 --port "$PORT"
