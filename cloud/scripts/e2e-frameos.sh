#!/usr/bin/env bash
# End-to-end happy path: the FrameOS backend (the monorepo root, one level
# up) linking to this cloud over real HTTP — device authorization, grants,
# login handoff, backups.
#
# Requires: local Postgres via scripts/db-setup.sh (port 55432), pnpm install,
# a Redis on localhost for the frameos backend tests, and the backend .venv
# installed at the repo root (override with FRAMEOS_DIR).
#
# Usage: scripts/e2e-frameos.sh
set -euo pipefail

cd "$(dirname "$0")/.."

CLOUD_URL="${CLOUD_URL:-http://localhost:3000}"
FRAMEOS_DIR="$(cd "${FRAMEOS_DIR:-..}" && pwd)"
PYTHON="${PYTHON:-$FRAMEOS_DIR/.venv/bin/python}"

if [ ! -x "$PYTHON" ]; then
  echo "frameos venv python not found at $PYTHON" >&2
  exit 1
fi

DATABASE_URL="${DATABASE_URL:-postgres://frameos_cloud@127.0.0.1:55432/frameos_cloud}"
export DATABASE_URL
scripts/db-migrate.sh

server_pid=""
cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if curl -sf "$CLOUD_URL/api/device/request?user_code=AAAAAAAA" >/dev/null 2>&1 || \
   curl -s -o /dev/null -w '%{http_code}' "$CLOUD_URL" | grep -q '200\|404'; then
  echo "Reusing running cloud server at $CLOUD_URL"
else
  echo "Starting cloud dev server at $CLOUD_URL"
  (cd apps/auth-web && pnpm dev >/tmp/frameos-cloud-e2e-server.log 2>&1) &
  server_pid=$!
  for _ in $(seq 1 120); do
    if curl -s -o /dev/null "$CLOUD_URL"; then
      break
    fi
    sleep 1
  done
fi

echo "Creating a verified e2e account"
account_json="$(CLOUD_URL="$CLOUD_URL" DATABASE_URL="$DATABASE_URL" node scripts/e2e-frameos-account.mjs)"
cookie="$(printf '%s' "$account_json" | node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d).cookie))')"
email="$(printf '%s' "$account_json" | node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d).email))')"
echo "Account: $email"

echo "Running the frameos backend e2e test"
cd "$FRAMEOS_DIR/backend"
# -u DATABASE_URL: that variable belongs to the cloud dev server; the frameos
# backend must fall back to its own sqlite test database.
env -u DATABASE_URL \
  FRAMEOS_CLOUD_E2E_URL="$CLOUD_URL" \
  FRAMEOS_CLOUD_E2E_COOKIE="$cookie" \
  FRAMEOS_CLOUD_E2E_EMAIL="$email" \
  "$PYTHON" -m pytest app/api/tests/test_cloud_e2e.py -v
