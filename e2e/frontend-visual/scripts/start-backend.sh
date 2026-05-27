#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${FRONTEND_VISUAL_PORT:-8989}"

export DEBUG="${DEBUG:-1}"
export SECRET_KEY="${SECRET_KEY:-frontend-visual-secret}"
export DATABASE_URL="${DATABASE_URL:-sqlite:///$ROOT/.tmp/frontend-visual.db}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379/15}"

mkdir -p "$ROOT/.tmp"

if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "frontend/dist is missing. Run: pnpm --dir frontend run build" >&2
  exit 1
fi

PYTHONPATH="$ROOT/backend" python "$ROOT/e2e/frontend-visual/scripts/seed_backend.py"

cd "$ROOT/backend"
exec python -m uvicorn app.fastapi:app --host 127.0.0.1 --port "$PORT"
