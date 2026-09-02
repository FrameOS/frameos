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

if [ -z "${DATABASE_URL:-}" ] && [ -f .env.local ]; then
  DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.local | head -n 1)"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set and .env.local does not provide it" >&2
  exit 1
fi

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
token_prefix="fc_apijob_"
token="${token_prefix}$(openssl rand 32 | b64url)"
token_hash="$(printf '%s' "$token" | openssl dgst -sha256 -binary | b64url)"
token_hint="${token:0:$((${#token_prefix} + 4))}"
token_access="billing_nightly"

# The service account is deliberately NOT a superadmin: the job token is
# what opens the nightly route, and the flag would only widen what a leaked
# token's account could do if it ever grew a login identity.

account_id="$(psql "$DATABASE_URL" --tuples-only --no-align -v ON_ERROR_STOP=1 \
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
identities="$(psql "$DATABASE_URL" --tuples-only --no-align -v ON_ERROR_STOP=1 \
  --set=id="$account_id" <<'SQL'
SELECT count(*) FROM account_identities WHERE account_id = :'id';
SQL
)"
if [ "$identities" != "0" ]; then
  echo "Refusing: $email has $identities login identity(ies) — a service account must have none" >&2
  exit 1
fi

if [ "$rotate" = true ]; then
  revoked="$(psql "$DATABASE_URL" --tuples-only --no-align -v ON_ERROR_STOP=1 \
    --set=id="$account_id" --set=token_name="$token_name" <<'SQL'
UPDATE account_api_tokens SET revoked_at = now(), updated_at = now()
 WHERE account_id = :'id' AND name = :'token_name' AND revoked_at IS NULL
RETURNING token_hint;
SQL
)"
  echo "Revoked: ${revoked:-nothing was live}"
fi

psql "$DATABASE_URL" --tuples-only --no-align -v ON_ERROR_STOP=1 \
  --set=id="$account_id" --set=token_name="$token_name" --set=token_access="$token_access" \
  --set=token_hash="$token_hash" --set=token_hint="$token_hint" >/dev/null <<'SQL'
INSERT INTO account_api_tokens (account_id, name, access, token_hash, token_hint)
VALUES (:'id', :'token_name', :'token_access', :'token_hash', :'token_hint');
INSERT INTO audit_events (account_id, actor, event_type, target, metadata)
VALUES (:'id', '{"kind":"script","script":"accounting-service-account.sh"}'::jsonb,
        'api_token.created', json_build_object('accountId', :'id', 'kind', 'account')::jsonb,
        json_build_object('name', :'token_name', 'tokenHint', :'token_hint')::jsonb);
SQL

cat <<MSG
Service account: $email ($account_id), not a superadmin
Job token, access $token_access (shown once — put it in /etc/frameos-cloud/accounting.env as ACCOUNTING_API_TOKEN):

  $token

MSG
