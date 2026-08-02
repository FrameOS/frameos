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
  [ -n "$server_pid" ] || return 0
  kill -0 "$server_pid" 2>/dev/null || return 0
  # Kill the whole process group (negative pid): $server_pid is the subshell,
  # and killing only that orphans `pnpm dev` and the next server it spawned,
  # which keeps listening on port 3000 long after this script exits. The
  # group exists because the job is started under `set -m` below.
  kill -TERM -"$server_pid" 2>/dev/null || kill -TERM "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  kill -KILL -"$server_pid" 2>/dev/null || true
}
trap cleanup EXIT

if curl -sf "$CLOUD_URL/api/device/request?user_code=AAAAAAAA" >/dev/null 2>&1 || \
   curl -s -o /dev/null -w '%{http_code}' "$CLOUD_URL" | grep -q '200\|404'; then
  echo "Reusing running cloud server at $CLOUD_URL"
else
  echo "Starting cloud dev server at $CLOUD_URL"
  # `set -m` gives the background job its own process group, so cleanup can
  # take down pnpm and the next server with it.
  set -m
  (cd apps/auth-web && pnpm dev >/tmp/frameos-cloud-e2e-server.log 2>&1) &
  server_pid=$!
  set +m
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
# FRAMEOS_PUBLIC_URL must be a loopback origin: the provider rejects
# non-local origins at link time (safeLocalOrigin), and the login handoff's
# redirect_uri must live on it.
env -u DATABASE_URL \
  FRAMEOS_CLOUD_E2E_URL="$CLOUD_URL" \
  FRAMEOS_CLOUD_E2E_COOKIE="$cookie" \
  FRAMEOS_CLOUD_E2E_EMAIL="$email" \
  FRAMEOS_PUBLIC_URL="http://127.0.0.1:8999" \
  "$PYTHON" -m pytest app/api/tests/test_cloud_e2e.py -v
