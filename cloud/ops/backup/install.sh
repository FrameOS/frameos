#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Installs the nightly backup job onto the production host: the script as
# /usr/local/bin/frameos-cloud-backup, the systemd service + timer, and a
# backup.env seeded from the example if none exists yet. Idempotent — re-run
# after editing pg-backup.sh to ship the new version.
#
# The one-time manual steps (order the Storage Box, write rclone.conf, create
# the healthchecks.io check) are in cloud/docs/backups.md.

deploy_host="${FRAMEOS_CLOUD_DEPLOY_HOST:-root@167.233.35.240}"
ssh_key="${FRAMEOS_CLOUD_DEPLOY_SSH_KEY:-$HOME/.ssh/hetzner}"

run() { ssh -i "$ssh_key" "$deploy_host" "$@"; }

echo "Installing backup script and systemd units on $deploy_host"
scp -i "$ssh_key" pg-backup.sh "$deploy_host:/usr/local/bin/frameos-cloud-backup"
run chmod 755 /usr/local/bin/frameos-cloud-backup
# The drill is deliberately NOT on a timer: it is a quarterly exercise a human
# runs and reads (cloud/docs/backups.md, "Rehearsal"). Shipping it here just
# means the box always has the current version to hand.
scp -i "$ssh_key" restore-drill.sh "$deploy_host:/usr/local/bin/frameos-cloud-restore-drill"
run chmod 755 /usr/local/bin/frameos-cloud-restore-drill
# The blob bytes are not in the database dump; they get their own copy.
scp -i "$ssh_key" object-store-backup.sh "$deploy_host:/usr/local/bin/frameos-cloud-object-backup"
run chmod 755 /usr/local/bin/frameos-cloud-object-backup
scp -i "$ssh_key" frameos-cloud-backup.service frameos-cloud-backup.timer \
  frameos-cloud-object-backup.service frameos-cloud-object-backup.timer \
  "$deploy_host:/etc/systemd/system/"

# Seed backup.env only when absent — it holds the healthchecks ping URL and
# any overrides, and must not be clobbered by a re-install.
if ! run "test -f /etc/frameos-cloud/backup.env"; then
  echo "Seeding /etc/frameos-cloud/backup.env from example"
  scp -i "$ssh_key" backup.env.example "$deploy_host:/etc/frameos-cloud/backup.env"
  run chmod 600 /etc/frameos-cloud/backup.env
fi

run "command -v rclone >/dev/null || (apt-get update -qq && apt-get install -y -qq rclone)"
if ! run "command -v pg_dump >/dev/null"; then
  echo "pg_dump missing on the host — install postgresql-client first." >&2
  exit 1
fi

run systemctl daemon-reload
run systemctl enable --now frameos-cloud-backup.timer
run systemctl enable --now frameos-cloud-object-backup.timer
run systemctl list-timers frameos-cloud-backup.timer frameos-cloud-object-backup.timer --no-pager

# The remote half needs Storage Box credentials, which only a human has.
# With the remote in place, run a first backup now so "installed" and
# "verified working" are the same event.
if run "rclone listremotes 2>/dev/null" | grep -q '^storagebox:$'; then
  echo "rclone remote 'storagebox' found — running a first backup now"
  run frameos-cloud-backup
  echo "Remote contents:"
  run '. /etc/frameos-cloud/backup.env 2>/dev/null; rclone lsl "${RCLONE_REMOTE:-storagebox:frameos-cloud-backups}"'
  if run "rclone listremotes 2>/dev/null" | grep -q '^r2:$'; then
    echo "rclone remote 'r2' found — copying the object store now"
    run systemctl start frameos-cloud-object-backup.service
    run systemctl status frameos-cloud-object-backup.service --no-pager -n 12 || true
  else
    echo "rclone remote 'r2' is not configured — the object-store backup timer will fail until it is (see rclone.conf.example)."
  fi
else
  cat <<'NEXT'

rclone remote 'storagebox' is not configured yet, so the timer will fail
until it is. On the server, create /root/.config/rclone/rclone.conf from
cloud/ops/backup/rclone.conf.example (setup steps: cloud/docs/backups.md,
"One-time setup"), then verify with:

  frameos-cloud-backup
NEXT
fi
