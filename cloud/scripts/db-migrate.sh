#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

database_url="${DATABASE_URL:-postgres://frameos_cloud:frameos_cloud@localhost:5432/frameos_cloud}"

psql "$database_url" -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" \
  >/dev/null

# psql only performs :'var' interpolation for SQL read from stdin, not for -c
# command strings, so feed the parameterized statements via heredocs. The
# migration name is passed as a psql variable rather than interpolated into the
# SQL text.
for migration in packages/db/drizzle/*.sql; do
  name="$(basename "$migration")"
  applied="$(psql "$database_url" -At -v name="$name" <<'SQL'
SELECT 1 FROM schema_migrations WHERE name = :'name';
SQL
)"
  if [ "$applied" = "1" ]; then
    echo "Skipping $name"
    continue
  fi

  echo "Applying $name"
  psql "$database_url" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
  psql "$database_url" -v ON_ERROR_STOP=1 -v name="$name" >/dev/null <<'SQL'
INSERT INTO schema_migrations (name) VALUES (:'name');
SQL
done
