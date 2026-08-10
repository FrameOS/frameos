#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

pgport="${FRAMEOS_CLOUD_PGPORT:-55432}"
# Data lives under the repo-root Flox environment (the only one since the
# cloud/.flox env merged into it); FRAMEOS_CLOUD_PGROOT overrides.
pgroot="${FRAMEOS_CLOUD_PGROOT:-$PWD/../.flox/postgres}"
pgdata="$pgroot/data"
database_url="postgres://frameos_cloud@127.0.0.1:$pgport/frameos_cloud"

mkdir -p "$pgroot"

if [ ! -s "$pgdata/PG_VERSION" ]; then
  echo "Initializing Postgres in $pgdata"
  initdb -D "$pgdata" --auth=trust --username=frameos_cloud >/dev/null
fi

# A listener on the port is not proof that it is *our* Postgres: an unrelated
# server on 55432 would silently receive the migrations below. Only accept one
# that answers as the frameos_cloud role.
# PGCONNECT_TIMEOUT: a listener that speaks something other than the Postgres
# wire protocol would otherwise hang the handshake indefinitely.
is_frameos_cloud_server() {
  [ "$(PGCONNECT_TIMEOUT=5 psql -h 127.0.0.1 -p "$pgport" -U frameos_cloud -d postgres -tAc 'select 1' 2>/dev/null || true)" = "1" ]
}

if pg_ctl -D "$pgdata" status >/dev/null 2>&1; then
  echo "Postgres is already running"
elif pg_isready -q -h 127.0.0.1 -p "$pgport"; then
  if ! is_frameos_cloud_server; then
    echo "Something is listening on 127.0.0.1:$pgport, but it does not answer as the frameos_cloud role." >&2
    echo "Refusing to migrate against it. Stop whatever owns the port, or set FRAMEOS_CLOUD_PGPORT." >&2
    exit 1
  fi
  echo "Postgres is already listening on 127.0.0.1:$pgport as frameos_cloud (e.g. the mprocs postgres proc or a sibling checkout)"
else
  echo "Starting Postgres on 127.0.0.1:$pgport"
  pg_ctl -D "$pgdata" -l "$pgroot/postgres.log" -o "-p $pgport" start >/dev/null
fi

createdb -h 127.0.0.1 -p "$pgport" -U frameos_cloud frameos_cloud >/dev/null 2>&1 || true

DATABASE_URL="$database_url" scripts/db-migrate.sh

env_file=".env.local"
app_env_file="apps/auth-web/.env.local"
session_secret="$(openssl rand -base64 32)"
encryption_key="$(openssl rand -base64 32)"

set_env_value() {
  key="$1"
  value="$2"
  file="$3"

  if grep -q "^$key=" "$file"; then
    tmp_file="$(mktemp)"
    awk -v key="$key" -v value="$value" '
      index($0, key "=") == 1 { print key "=" value; next }
      { print }
    ' "$file" >"$tmp_file"
    mv "$tmp_file" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

ensure_env_value() {
  key="$1"
  value="$2"
  file="$3"

  if grep -q "^$key=.\+" "$file"; then
    return
  fi

  set_env_value "$key" "$value" "$file"
}

if [ ! -f "$env_file" ]; then
  {
    printf 'FRAMEOS_CLOUD_APP_URL=http://localhost:3000\n'
    printf 'FRAMEOS_ACCOUNT_APP_URL=http://localhost:3000\n'
    printf 'FRAMEOS_SCENES_APP_URL=http://localhost:3000\n'
    printf 'GOOGLE_CLIENT_ID=\n'
    printf 'GOOGLE_CLIENT_SECRET=\n'
    printf 'SESSION_SECRET=%s\n' "$session_secret"
    printf 'DATABASE_URL=%s\n' "$database_url"
    printf 'FRAMEOS_CLOUD_ENCRYPTION_KEY=%s\n' "$encryption_key"
  } >"$env_file"
  echo "Created $env_file with local database and generated development secrets"
else
  ensure_env_value "FRAMEOS_CLOUD_APP_URL" "http://localhost:3000" "$env_file"
  ensure_env_value "FRAMEOS_ACCOUNT_APP_URL" "http://localhost:3000" "$env_file"
  ensure_env_value "FRAMEOS_SCENES_APP_URL" "http://localhost:3000" "$env_file"
  ensure_env_value "GOOGLE_CLIENT_ID" "" "$env_file"
  ensure_env_value "GOOGLE_CLIENT_SECRET" "" "$env_file"
  set_env_value "DATABASE_URL" "$database_url" "$env_file"
  ensure_env_value "SESSION_SECRET" "$session_secret" "$env_file"
  ensure_env_value "FRAMEOS_CLOUD_ENCRYPTION_KEY" "$encryption_key" "$env_file"
  echo "Updated $env_file with any missing local database settings"
fi

if [ ! -e "$app_env_file" ]; then
  ln -s ../../.env.local "$app_env_file"
  echo "Linked $app_env_file to ../../.env.local for Next.js local env loading"
fi

echo "DATABASE_URL=$database_url"
