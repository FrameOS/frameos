#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Installs the nightly accounting job onto the production host: the script as
# /usr/local/bin/frameos-cloud-accounting, its systemd service + timer, and
# an accounting.env seeded from the example if none exists yet. Idempotent —
# re-run after editing scripts/accounting-nightly.sh to ship the new version.
#
# Two manual steps, both in /etc/frameos-cloud/accounting.env: the token
# (mint one on a dedicated service account with
# scripts/accounting-service-account.sh — not a person's) and the
# healthchecks.io ping URL, which is required. This script checks both are
# set and refuses to enable the timer otherwise: a timer running a job that
# exits early on a missing variable every night is a job nobody notices is
# broken. See cloud/docs/accounting-todo.md §7 Phase 4 and
# cloud/docs/operational-runbooks.md.

deploy_host="${FRAMEOS_CLOUD_DEPLOY_HOST:-root@167.233.35.240}"
ssh_key="${FRAMEOS_CLOUD_DEPLOY_SSH_KEY:-$HOME/.ssh/hetzner}"

run() { ssh -i "$ssh_key" "$deploy_host" "$@"; }

echo "Installing the accounting job and systemd units on $deploy_host"
scp -i "$ssh_key" ../../scripts/accounting-nightly.sh \
  "$deploy_host:/usr/local/bin/frameos-cloud-accounting"
run chmod 755 /usr/local/bin/frameos-cloud-accounting
scp -i "$ssh_key" frameos-cloud-accounting.service frameos-cloud-accounting.timer \
  "$deploy_host:/etc/systemd/system/"

# Seed accounting.env only when absent: it holds the API token and must not
# be clobbered by a re-install.
if ! run "test -f /etc/frameos-cloud/accounting.env"; then
  echo "Seeding /etc/frameos-cloud/accounting.env from example"
  scp -i "$ssh_key" accounting.env.example "$deploy_host:/etc/frameos-cloud/accounting.env"
  run chmod 600 /etc/frameos-cloud/accounting.env
  echo "Set ACCOUNTING_API_TOKEN and ACCOUNTING_HEALTHCHECKS_URL in /etc/frameos-cloud/accounting.env before the first run."
fi

# Refuse to arm the timer on placeholders. Both values are the difference
# between a job that runs and one that fails quietly at 04:20 every night.
env_ok=true
if ! run "grep -Eq '^ACCOUNTING_API_TOKEN=fc_api_[A-Za-z0-9_-]{20,}\$' /etc/frameos-cloud/accounting.env" \
   || run "grep -q '^ACCOUNTING_API_TOKEN=fc_api_replace_me' /etc/frameos-cloud/accounting.env"; then
  echo "ACCOUNTING_API_TOKEN is not set in /etc/frameos-cloud/accounting.env (mint one with scripts/accounting-service-account.sh)" >&2
  env_ok=false
fi
if ! run "grep -Eq '^ACCOUNTING_HEALTHCHECKS_URL=(https://[^ ]+|none)\$' /etc/frameos-cloud/accounting.env" \
   || run "grep -q 'replace-me' /etc/frameos-cloud/accounting.env"; then
  echo "ACCOUNTING_HEALTHCHECKS_URL is not set in /etc/frameos-cloud/accounting.env (a healthchecks.io ping URL, or \"none\" to opt out on purpose)" >&2
  env_ok=false
fi
run systemctl daemon-reload
if [ "$env_ok" != true ]; then
  echo "Units installed; the timer is NOT enabled until both values are set. Re-run this script afterwards." >&2
  exit 1
fi
run systemctl enable --now frameos-cloud-accounting.timer
run systemctl list-timers --no-pager frameos-cloud-accounting.timer
