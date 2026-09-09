#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Installs the nightly database cleanup onto the production host: the systemd
# service + timer, and a cleanup.env seeded from the example if none exists
# yet. The script itself is not copied — the unit runs scripts/db-cleanup.sh
# out of the live release (/opt/frameos-cloud), so it follows every deploy.
# Idempotent; re-run after editing the units. See
# cloud/docs/operational-runbooks.md, "Maintenance Tasks".

deploy_host="${FRAMEOS_CLOUD_DEPLOY_HOST:-root@167.233.35.240}"
ssh_key="${FRAMEOS_CLOUD_DEPLOY_SSH_KEY:-$HOME/.ssh/hetzner}"

run() { ssh -i "$ssh_key" "$deploy_host" "$@"; }

echo "Installing the cleanup systemd units on $deploy_host"
scp -i "$ssh_key" frameos-cloud-cleanup.service frameos-cloud-cleanup.timer \
  "$deploy_host:/etc/systemd/system/"

if ! run "test -f /etc/frameos-cloud/cleanup.env"; then
  echo "Seeding /etc/frameos-cloud/cleanup.env from example"
  scp -i "$ssh_key" cleanup.env.example "$deploy_host:/etc/frameos-cloud/cleanup.env"
  run chmod 600 /etc/frameos-cloud/cleanup.env
fi

run systemctl daemon-reload
run systemctl enable --now frameos-cloud-cleanup.timer
run systemctl list-timers frameos-cloud-cleanup.timer --no-pager
echo "Done. A manual run: systemctl start frameos-cloud-cleanup.service"
