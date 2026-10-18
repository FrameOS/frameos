#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Installs the nightly database cleanup and the weekly object-store sweep onto
# the production host: their systemd services + timers, and a cleanup.env
# seeded from the example if none exists yet. The scripts themselves are not
# copied — the units run scripts/db-cleanup.sh and
# scripts/object-store-sweep.sh out of the live release (/opt/frameos-cloud),
# so they follow every deploy. Idempotent; re-run after editing the units. See
# cloud/docs/operational-runbooks.md, "Maintenance Tasks".

deploy_host="${FRAMEOS_CLOUD_DEPLOY_HOST:-root@167.233.35.240}"
ssh_key="${FRAMEOS_CLOUD_DEPLOY_SSH_KEY:-$HOME/.ssh/hetzner}"

run() { ssh -i "$ssh_key" "$deploy_host" "$@"; }

echo "Installing the cleanup systemd units on $deploy_host"
scp -i "$ssh_key" frameos-cloud-cleanup.service frameos-cloud-cleanup.timer \
  frameos-cloud-object-sweep.service frameos-cloud-object-sweep.timer \
  "$deploy_host:/etc/systemd/system/"
run "command -v rclone >/dev/null || (apt-get update -qq && apt-get install -y -qq rclone)"

if ! run "test -f /etc/frameos-cloud/cleanup.env"; then
  echo "Seeding /etc/frameos-cloud/cleanup.env from example"
  scp -i "$ssh_key" cleanup.env.example "$deploy_host:/etc/frameos-cloud/cleanup.env"
  run chmod 600 /etc/frameos-cloud/cleanup.env
fi

run systemctl daemon-reload
run systemctl enable --now frameos-cloud-cleanup.timer
run systemctl enable --now frameos-cloud-object-sweep.timer
run systemctl list-timers frameos-cloud-cleanup.timer frameos-cloud-object-sweep.timer --no-pager
echo "Done. Manual runs: systemctl start frameos-cloud-cleanup.service"
echo "and, to see what the sweep would delete without deleting it:"
echo "  systemd-run --wait --pipe -p User=frameos-cloud -p EnvironmentFile=/etc/frameos-cloud/auth-web.env -p WorkingDirectory=/opt/frameos-cloud/cloud /opt/frameos-cloud/cloud/scripts/object-store-sweep.sh"
