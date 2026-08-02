#!/usr/bin/env bash
# The long-running dev Postgres: this is what `pnpm run dev:postgres` and the
# mprocs "postgres" pane execute, so it must stay in the foreground for the
# lifetime of the pane. One-shot setup (create the database, run migrations,
# write .env.local) lives in db-setup.sh instead.
set -euo pipefail

cd "$(dirname "$0")/.."

pgport="${FRAMEOS_CLOUD_PGPORT:-55432}"
# Data lives under the repo-root Flox environment (the only one since the
# cloud/.flox env merged into it); FRAMEOS_CLOUD_PGROOT overrides.
pgroot="${FRAMEOS_CLOUD_PGROOT:-$PWD/../.flox/postgres}"
pgdata="$pgroot/data"

mkdir -p "$pgroot"

if [ ! -s "$pgdata/PG_VERSION" ]; then
  echo "Initializing Postgres in $pgdata"
  initdb -D "$pgdata" --auth=trust --username=frameos_cloud >/dev/null
fi

if pg_ctl -D "$pgdata" status >/dev/null 2>&1; then
  echo "Postgres is already running on 127.0.0.1:$pgport; tailing its log"
  touch "$pgroot/postgres.log"
  exec tail -f "$pgroot/postgres.log"
fi

if pg_isready -q -h 127.0.0.1 -p "$pgport"; then
  echo "Another Postgres is already listening on 127.0.0.1:$pgport (e.g. from a sibling checkout); using it"
  exec tail -f /dev/null
fi

echo "Starting Postgres on 127.0.0.1:$pgport"
exec postgres -D "$pgdata" -p "$pgport" -c listen_addresses=127.0.0.1
