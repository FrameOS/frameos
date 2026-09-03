#!/usr/bin/env bash
set -euo pipefail

# Applies packages/db/drizzle/*.sql in name order, once each, and records
# every applied file in schema_migrations.
#
# Each migration runs in ONE transaction together with its ledger row: the
# file's SQL is fed to `psql --single-transaction` with the
# `INSERT INTO schema_migrations` appended, so a statement that fails half
# way through a file rolls back everything before it and leaves no row.
# Before this, `psql -f` ran in autocommit and the row was inserted by a
# second psql call — a mid-file failure kept the DDL that had already run,
# recorded nothing, and every later deploy re-ran the file into
# "relation already exists". Now a failed migration leaves the database
# exactly as it was, and re-running the deploy simply retries it.
#
# Opt-out: a file whose FIRST line is exactly
#
#   -- migrate: no-transaction
#
# is applied the old way (autocommit, the ledger row inserted afterwards).
# That is for statements Postgres refuses inside a transaction block —
# CREATE INDEX CONCURRENTLY, VACUUM, CREATE/DROP DATABASE, ALTER TYPE ...
# ADD VALUE before PG 12 — and nothing else: such a file gets no atomicity
# and must be written so that re-running its surviving half is safe
# (IF NOT EXISTS everywhere). No current migration needs it.
#
# drizzle's `--> statement-breakpoint` markers are SQL comments; psql skips
# them either way.

cd "$(dirname "$0")/.."

database_url="${DATABASE_URL:-postgres://frameos_cloud:frameos_cloud@localhost:5432/frameos_cloud}"

psql "$database_url" -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" \
  >/dev/null

# psql only performs :'var' interpolation for SQL read from stdin or -f, not
# for -c command strings, so the parameterized statements are fed via
# heredocs / `-f -`. The migration name is passed as a psql variable rather
# than interpolated into the SQL text.
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

  if head -n 1 "$migration" | grep -qE '^--[[:space:]]*migrate:[[:space:]]*no-transaction[[:space:]]*$'; then
    echo "Applying $name (no-transaction: autocommit, ledger row afterwards)"
    psql "$database_url" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
    psql "$database_url" -v ON_ERROR_STOP=1 -v name="$name" >/dev/null <<'SQL'
INSERT INTO schema_migrations (name) VALUES (:'name');
SQL
    continue
  fi

  echo "Applying $name"
  # Two -f scripts, one transaction: --single-transaction issues BEGIN before
  # the first -f and COMMIT after the last (it needs -f/-c to act on; bare
  # stdin is not one), and `-f -` is stdin read as a script, which is where
  # the :'name' interpolation is honoured. The file keeps its own -f so an
  # error names it and its line. ON_ERROR_STOP makes psql quit on the first
  # failed statement, so the open transaction is never committed.
  psql "$database_url" --single-transaction -v ON_ERROR_STOP=1 -v name="$name" \
    -f "$migration" -f - >/dev/null <<'SQL'
INSERT INTO schema_migrations (name) VALUES (:'name');
SQL
done
