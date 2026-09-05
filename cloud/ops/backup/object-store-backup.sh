#!/usr/bin/env bash
set -euo pipefail

# Nightly off-Cloudflare copy of the blob store, encrypted on the way out
# (rclone crypt — see cloud/ops/backup/rclone.conf.example). Installed as
# /usr/local/bin/frameos-cloud-object-backup by ops/backup/install.sh and run
# by frameos-cloud-object-backup.timer. Runbook: cloud/docs/backups.md.
#
# Why this exists: since the blobs moved to R2, a Postgres backup restores
# every row, key and recorded size and none of the bytes. Cloudflare replicates
# within the bucket, which covers hardware and not mistakes — a leaked API key
# deleting objects, or a bug deleting the wrong ones, is replicated faithfully.
#
# **copy, never sync.** Sync would mirror a deletion in R2 onto the backup,
# which is precisely the failure this is here for. Objects are immutable and
# named after the sha256 of their own content, so copy-only is not just safe
# but complete: the backup accumulates every object that has ever existed, and
# an object present in it is by construction the right bytes for its key.
# `--immutable` makes rclone fail rather than overwrite if a key's content ever
# changes, which would mean something is very wrong upstream.
#
# To run manually: `systemctl start frameos-cloud-object-backup.service` — the
# R2 credentials come from the unit's EnvironmentFile, not from here.

rclone_remote="${OBJECT_BACKUP_REMOTE:-boxcrypt:objects}"
source_remote="${OBJECT_STORE_REMOTE:-r2:frameos-cloud}"
healthchecks_url="${OBJECT_BACKUP_HEALTHCHECKS_URL:-}"

ping_healthcheck() {
  [ -n "$healthchecks_url" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${healthchecks_url}${1:-}" || true
}

fail() {
  echo "object-store backup failed: $1" >&2
  ping_healthcheck "/fail"
  exit 1
}

ping_healthcheck "/start"

command -v rclone >/dev/null || fail "rclone is not installed"
rclone listremotes | grep -qx "${source_remote%%:*}:" || fail "rclone remote '${source_remote%%:*}' is not configured"
rclone listremotes | grep -qx "${rclone_remote%%:*}:" || fail "rclone remote '${rclone_remote%%:*}' is not configured"
# Same rule as the database backup: nothing leaves the box in clear. The
# copy goes through an rclone crypt remote (names and bytes encrypted with a
# key the Storage Box never sees); a plaintext destination is refused unless
# ALLOW_PLAINTEXT_REMOTE=1, which is for rehearsal VMs only.
if [ "${ALLOW_PLAINTEXT_REMOTE:-0}" != "1" ] &&
  ! rclone config show "${rclone_remote%%:*}" 2>/dev/null | grep -qE '^type *= *crypt$'; then
  fail "OBJECT_BACKUP_REMOTE=${rclone_remote} is not an rclone crypt remote — refusing to ship plaintext copies off the box"
fi

echo "Copying $source_remote -> $rclone_remote"
rclone copy "$source_remote" "$rclone_remote" \
  --immutable \
  --transfers 4 \
  --checkers 8 \
  --stats-one-line \
  --stats 1m \
  || fail "rclone copy returned non-zero"

# Count both sides. A backup that silently copied nothing because the source
# remote pointed at an empty bucket would otherwise look identical to a
# healthy no-op night.
source_count="$(rclone size "$source_remote" --json | sed -n 's/.*"count":\([0-9]*\).*/\1/p')"
backup_count="$(rclone size "$rclone_remote" --json | sed -n 's/.*"count":\([0-9]*\).*/\1/p')"
echo "objects in store: ${source_count:-?}, objects in backup: ${backup_count:-?}"

[ -n "$source_count" ] || fail "could not count objects in $source_remote"
[ "$source_count" -gt 0 ] || fail "$source_remote reports zero objects — refusing to call that a successful backup"
# The backup may legitimately hold MORE than the store (it keeps what sweeps
# and deletes removed); fewer means this run did not finish its job.
[ "${backup_count:-0}" -ge "$source_count" ] || fail "backup holds $backup_count objects, fewer than the store's $source_count"

ping_healthcheck
echo "Object store backup complete."
