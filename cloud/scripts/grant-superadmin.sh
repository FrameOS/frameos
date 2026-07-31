#!/usr/bin/env bash
# Grant (or revoke) the superadmin flag for the account behind an email.
# Usage:
#   scripts/grant-superadmin.sh you@example.com
#   scripts/grant-superadmin.sh --revoke you@example.com
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

email="${1:-}"
if [ -z "$email" ]; then
  echo "Usage: scripts/grant-superadmin.sh [--revoke] <email>" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ] && [ -f .env.local ]; then
  DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.local | head -n 1)"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set and .env.local does not provide it" >&2
  exit 1
fi

value=true
if [ "$revoke" = true ]; then
  value=false
fi

updated="$(psql "$DATABASE_URL" --tuples-only --no-align \
  --set=email="$email" --set=value="$value" <<'SQL'
UPDATE accounts
SET is_superadmin = :'value'::boolean, updated_at = now()
WHERE id IN (
  SELECT account_id
  FROM account_identities
  WHERE lower(provider_subject) = lower(:'email')
     OR lower(email_snapshot) = lower(:'email')
)
RETURNING id;
SQL
)"

if [ -z "$updated" ]; then
  echo "No account found for $email (the account must sign in once first)" >&2
  exit 1
fi

echo "is_superadmin=$value for account(s):"
echo "$updated"
