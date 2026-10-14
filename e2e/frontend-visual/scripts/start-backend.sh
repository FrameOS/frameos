#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${FRONTEND_VISUAL_PORT:-8989}"

export DEBUG="${DEBUG:-1}"
export SECRET_KEY="${SECRET_KEY:-frontend-visual-secret}"
export DATABASE_URL="${DATABASE_URL:-sqlite:///$ROOT/.tmp/frontend-visual.db}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379/15}"

mkdir -p "$ROOT/.tmp"

# The Photos library (tests/photos.spec.ts) keeps its bytes on disk next to
# the rows: give it a folder as disposable as the database. Only the default
# is wiped.
if [ -z "${FRAMEOS_PHOTOS_DIR:-}" ]; then
  export FRAMEOS_PHOTOS_DIR="$ROOT/.tmp/frontend-visual-photos"
  rm -rf "$FRAMEOS_PHOTOS_DIR"
fi

if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "frontend/dist is missing. Run: pnpm --dir frontend run build" >&2
  exit 1
fi

PYTHONPATH="$ROOT/backend" python "$ROOT/e2e/frontend-visual/scripts/seed_backend.py"

cd "$ROOT/backend"
exec python -m uvicorn app.fastapi:app --host 127.0.0.1 --port "$PORT"
