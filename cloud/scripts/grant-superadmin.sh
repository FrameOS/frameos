#!/usr/bin/env bash
# Grant (or revoke) the superadmin flag for one account.
# Usage:
#   scripts/grant-superadmin.sh you@example.com
#   scripts/grant-superadmin.sh 0f1e2d3c-…-account-uuid
#   scripts/grant-superadmin.sh --revoke you@example.com
#
# The argument is an account id, or an email that a login identity has
# VERIFIED (account_identities.email_verified). accounts.primary_email and
# account_identities.email_snapshot are display snapshots the schema says
# never to look an account up by: anyone can sign up with a password and
# type the CEO's address, and until the verification mail is clicked that
# row would have matched here. An email that only matches unverified rows
# is reported as such rather than granted.
#
# Uses DATABASE_URL from the environment or .env.local. This is the bootstrap
# path for the first superadmin; afterwards the /admin panel can manage flags.
set -euo pipefail

cd "$(dirname "$0")/.."

revoke=false
if [ "${1:-}" = "--revoke" ]; then
  revoke=true
  shift
fi

target="${1:-}"
if [ -z "$target" ]; then
  echo "Usage: scripts/grant-superadmin.sh [--revoke] <account-id | verified-email>" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ] && [ -f .env.local ]; then
  DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.local | head -n 1)"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set and .env.local does not provide it" >&2
  exit 1
fi
# The URL never goes on a command line (ps / /proc show argv to every local
# account): it becomes libpq's PG* environment and psql runs bare.
# shellcheck source=scripts/lib/pg-env.sh
. scripts/lib/pg-env.sh
pg_env_from_url "$DATABASE_URL"

value=true
if [ "$revoke" = true ]; then
  value=false
fi

# One of the two shapes, decided here so the SQL below never has to guess.
uuid_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
if [[ "$target" =~ $uuid_re ]]; then
  by="id"
else
  by="email"
fi

updated="$(psql --quiet --tuples-only --no-align -v ON_ERROR_STOP=1 \
  --set=target="$target" --set=by="$by" --set=value="$value" <<'SQL'
UPDATE accounts
SET is_superadmin = :'value'::boolean, updated_at = now()
-- Compared as text: a ::uuid cast of an email would fail at parse time
-- even on the branch the OR never takes.
WHERE (:'by' = 'id' AND id::text = lower(:'target'))
   OR (:'by' = 'email' AND id IN (
        SELECT account_id
        FROM account_identities
        WHERE email_verified
          AND lower(email_snapshot) = lower(:'target')
      ))
RETURNING id;
SQL
)"

if [ -z "$updated" ]; then
  if [ "$by" = "email" ]; then
    unverified="$(psql --quiet --tuples-only --no-align -v ON_ERROR_STOP=1 \
      --set=target="$target" <<'SQL'
SELECT count(*) FROM account_identities
WHERE NOT email_verified AND lower(email_snapshot) = lower(:'target');
SQL
)"
    if [ "${unverified:-0}" != "0" ]; then
      echo "Refusing: $target matches only UNVERIFIED identities ($unverified). Have the person verify the address, or pass the account id." >&2
      exit 1
    fi
  fi
  echo "No account found for $target (an account id, or an email a login identity has verified; the account must sign in once first)" >&2
  exit 1
fi

echo "is_superadmin=$value for account(s):"
echo "$updated"
