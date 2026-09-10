#!/usr/bin/env bash
# Mint (or rotate) the JOB token the nightly accounting job runs as, on a
# dedicated service account rather than a person's.
#
# Usage:
#   scripts/accounting-service-account.sh            # create account if absent, mint a token
#   scripts/accounting-service-account.sh --rotate   # revoke the job's live tokens, mint a new one
#
# Why a service account (cloud/docs/accounting-todo.md §9.3): a personal
# token is revoked on its owner's way out, or expires with their account,
# and the job dies with it — silently, at 04:20, with nothing but a missing
# healthchecks ping to say so. The account made here has no login identity
# (no account_identities row), so nobody can sign in as it; the token is
# its only door, and this script is the only thing that mints one.
#
# Why a JOB token and not a superadmin's (docs/security-todo.md, 2026-09):
# the token is `fc_apijob_…` with access `billing_nightly`, which
# api-tokens.ts accepts on exactly one route — POST /api/admin/billing/nightly
# — and refuses everywhere readSession() is asked. The account is NOT a
# superadmin (this script clears the flag if an earlier version set it): a
# leaked accounting.env buys the sweep and nothing else, where the old
# superadmin `fc_api_` token could read every account, post journal entries
# and grant superadmin from the ops box.
#
# The token EXPIRES (ACCOUNTING_TOKEN_TTL_DAYS, default 90): a credential
# that sits in a file on the ops box for years is the one nobody remembers
# to rotate, and api-tokens.ts already refuses an expired row. The nightly
# job's response carries the expiry and accounting-nightly.sh warns for the
# last two weeks; rotate with --rotate before then (operational-runbooks.md,
# "The nightly accounting job").
#
# Prints the token ONCE. Put it in /etc/frameos-cloud/accounting.env as
# ACCOUNTING_API_TOKEN. Uses DATABASE_URL from the environment or .env.local,
# like grant-superadmin.sh — run it on the production box or over a tunnel.
# After the deploy that introduced job tokens, run it with --rotate once:
# the old superadmin token no longer opens the nightly route.
#
# The token format and hash match src/lib/api-tokens.ts + secrets.ts:
# `fc_apijob_` + base64url(32 random bytes), stored as base64url(sha256(token));
# the hint is the prefix plus the first four random characters.
set -euo pipefail

cd "$(dirname "$0")/.."

rotate=false
if [ "${1:-}" = "--rotate" ]; then
  rotate=true
  shift
fi

email="${ACCOUNTING_SERVICE_EMAIL:-accounting-job@frameos.net}"
name="${ACCOUNTING_SERVICE_NAME:-Accounting nightly job}"
token_name="${ACCOUNTING_TOKEN_NAME:-nightly accounting job}"
ttl_days="${ACCOUNTING_TOKEN_TTL_DAYS:-90}"
if ! [[ "$ttl_days" =~ ^[0-9]+$ ]] || [ "$ttl_days" -lt 1 ]; then
  echo "ACCOUNTING_TOKEN_TTL_DAYS must be a positive integer, got: $ttl_days" >&2
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

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
token_prefix="fc_apijob_"
token="${token_prefix}$(openssl rand 32 | b64url)"
token_hash="$(printf '%s' "$token" | openssl dgst -sha256 -binary | b64url)"
token_hint="${token:0:$((${#token_prefix} + 4))}"
token_access="billing_nightly"

# The service account is deliberately NOT a superadmin: the job token is
# what opens the nightly route, and the flag would only widen what a leaked
# token's account could do if it ever grew a login identity.

account_id="$(psql --tuples-only --no-align -v ON_ERROR_STOP=1 \
  --set=email="$email" --set=name="$name" <<'SQL'
INSERT INTO accounts (display_name, primary_email, is_superadmin)
SELECT :'name', :'email', false
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE primary_email = :'email');
UPDATE accounts SET is_superadmin = false, updated_at = now()
 WHERE primary_email = :'email' AND is_superadmin;
SELECT id FROM accounts WHERE primary_email = :'email';
SQL
)"
account_id="$(printf '%s' "$account_id" | tail -n 1)"
if [ -z "$account_id" ]; then
  echo "Could not create or find the service account $email" >&2
  exit 1
fi

# A service account must never be able to log in: refuse if somebody has
# attached an identity to it since.
# (Heredoc, not -c: psql only interpolates :'var' in SQL read from stdin.)
identities="$(psql --tuples-only --no-align -v ON_ERROR_STOP=1 \
  --set=id="$account_id" <<'SQL'
SELECT count(*) FROM account_identities WHERE account_id = :'id';
SQL
)"
if [ "$identities" != "0" ]; then
  echo "Refusing: $email has $identities login identity(ies) — a service account must have none" >&2
  exit 1
fi

if [ "$rotate" = true ]; then
  revoked="$(psql --quiet --tuples-only --no-align -v ON_ERROR_STOP=1 \
    --set=id="$account_id" --set=token_name="$token_name" <<'SQL'
UPDATE account_api_tokens SET revoked_at = now(), updated_at = now()
 WHERE account_id = :'id' AND name = :'token_name' AND revoked_at IS NULL
RETURNING token_hint;
SQL
)"
  echo "Revoked: ${revoked:-nothing was live}"
fi

expires_at="$(psql --quiet --tuples-only --no-align -v ON_ERROR_STOP=1 \
  --set=id="$account_id" --set=token_name="$token_name" --set=token_access="$token_access" \
  --set=token_hash="$token_hash" --set=token_hint="$token_hint" --set=ttl_days="$ttl_days" <<'SQL'
WITH minted AS (
  INSERT INTO account_api_tokens (account_id, name, access, token_hash, token_hint, expires_at)
  VALUES (:'id', :'token_name', :'token_access', :'token_hash', :'token_hint',
          now() + make_interval(days => :'ttl_days'::int))
  RETURNING expires_at
), audited AS (
  INSERT INTO audit_events (account_id, actor, event_type, target, metadata)
  SELECT :'id', '{"kind":"script","script":"accounting-service-account.sh"}'::jsonb,
         'api_token.created', json_build_object('accountId', :'id', 'kind', 'account')::jsonb,
         json_build_object('name', :'token_name', 'tokenHint', :'token_hint',
                           'expiresAt', to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))::jsonb
  FROM minted
)
SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM minted;
SQL
)"

cat <<MSG
Service account: $email ($account_id), not a superadmin
Job token, access $token_access, expires $expires_at (${ttl_days} days; rotate before then with --rotate).
Shown once — put it in /etc/frameos-cloud/accounting.env as ACCOUNTING_API_TOKEN:

  $token

MSG
