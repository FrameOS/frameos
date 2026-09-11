#!/usr/bin/env bash
# Push this directory to the runner host and make the pool match it.
#   tools/gha-runners/sync-to-host.sh [user@host]      (default: marius@monster)
# Copies bin/, slots/ and README.md into /srv/gha-runners (slot env files
# removed here are removed there), installs the unit, then runs
# gha-reload-slots.sh, which restarts every idle slot so it picks the new
# settings up and lists the busy ones to rerun for later. Everything on the
# host is root-owned, so the copy goes through a staging directory and sudo.
set -euo pipefail
HOST=${1:-marius@116.202.150.114}
SRC=$(cd "$(dirname "$0")" && pwd)
STAGE=/tmp/gha-runners-sync

rsync -a --delete --exclude host/ --exclude sync-to-host.sh "$SRC/" "$HOST:$STAGE/"
# shellcheck disable=SC2029
ssh "$HOST" "sudo -n sh -c '
  set -e
  rsync -a --delete $STAGE/bin/ /srv/gha-runners/bin/
  rsync -a --delete $STAGE/slots/ /srv/gha-runners/slots/
  cp $STAGE/README.md /srv/gha-runners/README.md
  chmod 0755 /srv/gha-runners/bin/*.sh
  cp $STAGE/gha-runner@.service /etc/systemd/system/gha-runner@.service
  systemctl daemon-reload
  /srv/gha-runners/bin/gha-reload-slots.sh
'"
