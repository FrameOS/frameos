#!/usr/bin/env bash
set -euo pipefail

# The nightly accounting job: sweep AI usage records whose ledger entries
# never landed, then run every ledger invariant and report what fails.
#
# The work itself is POST /api/admin/billing/nightly, not this script. That
# is deliberate: the invariants are TypeScript in cloud/packages/ledger and
# they are the same code the test suite runs, so there is one definition of
# "the books are consistent" — proven on fresh data by the suite and on
# production data by this. A psql sibling of db-cleanup.sh would have meant a
# second copy of every query, drifting from the first from the day after it
# was written. (The release bundle is Next's standalone output and carries no
# tsx, which is why this cannot simply be a Node script either — the same
# reason object-store-sweep.sh is bash.)
#
# Authentication is a personal API token belonging to a superadmin, which is
# an auth mechanism that already exists rather than a new shared secret:
#
#   /etc/frameos-cloud/accounting.env
#     ACCOUNTING_API_TOKEN=fc_api_...
#     ACCOUNTING_URL=https://cloud.frameos.net/api/admin/billing/nightly
#     ACCOUNTING_HEALTHCHECKS_URL=https://hc-ping.com/...   # optional
#
# Create the token at /account/api-tokens as a superadmin. Run nightly via
# ops/accounting/frameos-cloud-accounting.timer; see
# cloud/docs/operational-runbooks.md.
#
# Exit status is the alert: 0 when the sweep worked and every invariant
# holds, 1 when anything needs a human. Violations are NOT fixed
# automatically — books that disagree with themselves need somebody to look,
# and quietly "correcting" them is how a discrepancy becomes undiscoverable.

url="${ACCOUNTING_URL:-http://127.0.0.1:3000/api/admin/billing/nightly}"
token="${ACCOUNTING_API_TOKEN:?set ACCOUNTING_API_TOKEN in /etc/frameos-cloud/accounting.env}"
ping_url="${ACCOUNTING_HEALTHCHECKS_URL:-}"

response="$(mktemp)"
trap 'rm -f "$response"' EXIT

status="$(curl -sS -o "$response" -w '%{http_code}' \
  --max-time 300 \
  -X POST \
  -H "authorization: Bearer ${token}" \
  -H 'content-type: application/json' \
  --data '{}' \
  "$url" || echo 000)"

body="$(cat "$response")"

if [ "$status" != "200" ]; then
  echo "FAIL: ${url} -> HTTP ${status}: ${body}" >&2
  [ -n "$ping_url" ] && curl -fsS -m 10 -o /dev/null --data-raw "HTTP ${status}" "${ping_url}/fail" || true
  exit 1
fi

echo "$body"

# `ok` is false when the sweep left failures behind or any invariant broke.
# No jq on the box, and this is the only field that needs reading.
if printf '%s' "$body" | grep -q '"ok":true'; then
  [ -n "$ping_url" ] && curl -fsS -m 10 -o /dev/null --data-raw "$body" "$ping_url" || true
  exit 0
fi

echo "FAIL: the ledger reported violations or a failed sweep" >&2
[ -n "$ping_url" ] && curl -fsS -m 10 -o /dev/null --data-raw "$body" "${ping_url}/fail" || true
exit 1
