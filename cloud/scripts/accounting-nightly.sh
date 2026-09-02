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
# Authentication is an API token on a superadmin account, which is an auth
# mechanism that already exists rather than a new shared secret:
#
#   /etc/frameos-cloud/accounting.env
#     ACCOUNTING_API_TOKEN=fc_api_...
#     ACCOUNTING_URL=https://cloud.frameos.net/api/admin/billing/nightly
#     ACCOUNTING_HEALTHCHECKS_URL=https://hc-ping.com/...   # or "none"
#
# Whose token: a dedicated service account, minted by
# scripts/accounting-service-account.sh, NOT a person's. A personal token
# dies with the person — revoked on their way out, or expired with their
# account — and the job with it, silently (§9.3). Run nightly via
# ops/accounting/frameos-cloud-accounting.timer; see
# cloud/docs/operational-runbooks.md.
#
# The healthchecks ping is REQUIRED. This is a dead-man job: the failure
# mode that matters is not a loud error but a night that never ran, and
# only an external check that expects a ping can notice that. A deployment
# that genuinely has nowhere to ping says so with ACCOUNTING_HEALTHCHECKS_URL=none
# rather than by leaving it unset.
#
# Exit status is the alert: 0 when the sweep worked and every invariant
# holds, 1 when anything needs a human. Violations are NOT fixed
# automatically — books that disagree with themselves need somebody to look,
# and quietly "correcting" them is how a discrepancy becomes undiscoverable.

url="${ACCOUNTING_URL:-http://127.0.0.1:3000/api/admin/billing/nightly}"
token="${ACCOUNTING_API_TOKEN:?set ACCOUNTING_API_TOKEN in /etc/frameos-cloud/accounting.env}"
ping_url="${ACCOUNTING_HEALTHCHECKS_URL:?set ACCOUNTING_HEALTHCHECKS_URL in /etc/frameos-cloud/accounting.env (a healthchecks.io ping URL, or "none" to opt out of the dead-man check on purpose)}"
if [ "$ping_url" = "none" ]; then
  ping_url=""
fi

# The token reaches curl through a header file (`-H @file`), never as an
# argument: a process's command line is readable by every user on the box
# in `ps` / /proc/*/cmdline for as long as the request runs — up to the
# 300 s below — and this token is a superadmin's. The directory is created
# 0700 by mktemp -d; the umask keeps the files inside it 0600.
workdir="$(umask 077 && mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
header_file="$workdir/authorization"
response="$workdir/response"
(umask 077 && printf 'authorization: Bearer %s\n' "$token" >"$header_file")

status="$(curl -sS -o "$response" -w '%{http_code}' \
  --max-time 300 \
  -X POST \
  -H @"$header_file" \
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
