#!/usr/bin/env bash
# The backend's provider sidecar in development (the `backend-provider`
# mprocs pane): FrameOS Cloud's frame hub plus the bridge the backend drives it
# through (cloud/apps/backend-provider), on its own database in the Flox
# Postgres the `postgres` pane runs. Ports 3110/3111, clear of a dev cloud
# hub on 3100; backend/bin/dev-api and dev-worker point the backend here with
# the same secret.
set -euo pipefail
cd "$(dirname "$0")/.."

pgport="${FRAMEOS_CLOUD_PGPORT:-55432}"
until pg_isready -q -h 127.0.0.1 -p "$pgport"; do
  echo "Waiting for Postgres on 127.0.0.1:$pgport (the postgres pane)"
  sleep 2
done
createdb -h 127.0.0.1 -p "$pgport" -U frameos_cloud frameos_backend_provider 2>/dev/null || true

export DATABASE_URL="postgres://frameos_cloud@127.0.0.1:$pgport/frameos_backend_provider"
export SESSION_SECRET="${FRAMEOS_DEV_PROVIDER_SESSION_SECRET:-frameos-dev-provider-session-secret}"
export FRAMEOS_PROVIDER_BRIDGE_SECRET="${FRAMEOS_PROVIDER_BRIDGE_SECRET:-frameos-dev-provider-bridge-secret}"
export FRAMEOS_OBJECT_STORE_DIR="$PWD/db/provider-objects"
export FRAME_HUB_PORT="${FRAME_HUB_PORT:-3110}"
export FRAMEOS_PROVIDER_BRIDGE_PORT="${FRAMEOS_PROVIDER_BRIDGE_PORT:-3111}"
export RATE_LIMIT_TRUSTED_PROXY_COUNT=1
exec pnpm --filter @frameos-cloud/backend-provider dev
