#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Installs the nightly accounting job onto the production host: the script as
# /usr/local/bin/frameos-cloud-accounting, its systemd service + timer, and
# an accounting.env seeded from the example if none exists yet. Idempotent —
# re-run after editing scripts/accounting-nightly.sh to ship the new version.
#
# The one manual step is the token: create a personal API token as a
# superadmin at /account/api-tokens and put it in
# /etc/frameos-cloud/accounting.env. See cloud/docs/accounting-todo.md §7
# Phase 4 and cloud/docs/operational-runbooks.md.

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
  echo "Set ACCOUNTING_API_TOKEN in /etc/frameos-cloud/accounting.env before the first run."
fi

run systemctl daemon-reload
run systemctl enable --now frameos-cloud-accounting.timer
run systemctl list-timers --no-pager frameos-cloud-accounting.timer
