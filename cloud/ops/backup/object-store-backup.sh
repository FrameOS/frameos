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
# **copy, never sync, for store objects.** Sync would mirror a deletion in R2
# onto the backup, which is precisely the failure this is here for. Store
# objects are immutable and named after the sha256 of their own content, so
# copy-only is not just safe but complete: the backup accumulates every
# object that has ever existed, and an object present in it is by
# construction the right bytes for its key. `--immutable` makes rclone fail
# rather than overwrite if a key's content ever changes, which would mean
# something is very wrong upstream.
#
# **Photos and frame snapshots are the exception** (`photos/`, `frames/`):
# one person's pictures, and screenshots of them. Kept forever they would
# outlive the owner deleting them, and the account too. Those two prefixes
# are synced instead, with every object a run would delete MOVED into
# `$deleted_remote/<date>/` rather than removed, and a dated folder is purged
# once it is older than DELETED_OBJECT_RETENTION_DAYS (30). A wipe or a bug
# still has that long to be noticed and copied back (cloud/docs/backups.md,
# "Restoring"); a real deletion is gone from the backup a month later.
#
# To run manually: `systemctl start frameos-cloud-object-backup.service` — the
# R2 credentials come from the unit's EnvironmentFile, not from here.

rclone_remote="${OBJECT_BACKUP_REMOTE:-boxcrypt:objects}"
source_remote="${OBJECT_STORE_REMOTE:-r2:frameos-cloud}"
# Must be on the same remote as the backup (rclone moves objects there
# server side) and outside it.
deleted_remote="${OBJECT_BACKUP_DELETED_REMOTE:-${rclone_remote%%:*}:objects-deleted}"
deleted_retention_days="${DELETED_OBJECT_RETENTION_DAYS:-30}"
# The prefixes that hold one person's pictures (see above).
private_prefixes="photos frames"
healthchecks_url="${OBJECT_BACKUP_HEALTHCHECKS_URL:-}"

ping_healthcheck() {
  [ -n "$healthchecks_url" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${healthchecks_url}${1:-}" || true
}

# One row per run in the cloud's backup_runs table (see pg-backup.sh). The
# URL stays off argv: libpq reads a connection URI from PGDATABASE as well.
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
record_run() {
  # $1: ok (true|false), $2: summary
  [ -n "${DATABASE_URL:-}" ] || return 0
  PGDATABASE="$DATABASE_URL" psql -q -v ON_ERROR_STOP=1 -v kind=objects -v ok="$1" -v summary="$2" -v started="$started_at" <<'SQL' 2>/dev/null || echo "note: could not record the run in backup_runs (migration 0056 applied?)" >&2
INSERT INTO backup_runs (kind, ok, summary, started_at)
VALUES (:'kind', :'ok'::boolean, :'summary', :'started'::timestamptz);
SQL
}
fail() {
  echo "object-store backup failed: $1" >&2
  ping_healthcheck "/fail"
  record_run false "$1"
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

case "$deleted_retention_days" in
  '' | *[!0-9]*) fail "DELETED_OBJECT_RETENTION_DAYS=$deleted_retention_days is not a number of days" ;;
esac
[ "${deleted_remote%%:*}" = "${rclone_remote%%:*}" ] ||
  fail "OBJECT_BACKUP_DELETED_REMOTE=$deleted_remote must be on the backup's remote (${rclone_remote%%:*}:)"

excludes=()
for prefix in $private_prefixes; do
  excludes+=(--exclude "/$prefix/**")
done
echo "Copying $source_remote -> $rclone_remote (all but: $private_prefixes)"
rclone copy "$source_remote" "$rclone_remote" \
  "${excludes[@]}" \
  --immutable \
  --transfers 4 \
  --checkers 8 \
  --stats-one-line \
  --stats 1m \
  || fail "rclone copy returned non-zero"

# rclone sync deletes nothing when any read during the run failed, so a
# listing that broke halfway never looks like an empty bucket. A bucket that
# really was emptied (a leaked key, a bad sweep) is the other case: the
# backup would follow it and purge everything a month later. So a run that
# would take more than half of a prefix's backup stops and pages instead;
# OBJECT_BACKUP_ALLOW_MASS_DELETE=1 lets the next run through once a human
# has looked.
# A prefix the backup does not have yet counts as empty.
count_objects() {
  { rclone size "$1" --json 2>/dev/null || true; } | sed -n 's/.*"count":\([0-9]*\).*/\1/p'
}
today="$(date -u +%Y-%m-%d)"
for prefix in $private_prefixes; do
  in_store="$(count_objects "$source_remote/$prefix")"
  in_backup="$(count_objects "$rclone_remote/$prefix")"
  if [ "${OBJECT_BACKUP_ALLOW_MASS_DELETE:-0}" != "1" ] && [ "${in_backup:-0}" -ge 20 ] &&
    [ $((${in_store:-0} * 2)) -lt "$in_backup" ]; then
    fail "$source_remote/$prefix holds ${in_store:-0} objects but the backup has $in_backup: refusing to mirror a mass deletion (set OBJECT_BACKUP_ALLOW_MASS_DELETE=1 for one run if it is real)"
  fi
  echo "Syncing $source_remote/$prefix -> $rclone_remote/$prefix (deletions kept in $deleted_remote/$today/$prefix)"
  rclone sync "$source_remote/$prefix" "$rclone_remote/$prefix" \
    --backup-dir "$deleted_remote/$today/$prefix" \
    --immutable \
    --transfers 4 \
    --checkers 8 \
    --stats-one-line \
    --stats 1m \
    || fail "rclone sync of $prefix/ returned non-zero"
done

# What the owners deleted more than the retention ago leaves the backup for
# good. Folder names are dates, so the cutoff is a string compare.
cutoff="$(date -u -d "-${deleted_retention_days} days" +%Y-%m-%d)"
purged=0
while IFS= read -r folder; do
  folder="${folder%/}"
  case "$folder" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) continue ;;
  esac
  if [[ "$folder" < "$cutoff" ]]; then
    echo "Purging $deleted_remote/$folder (older than $deleted_retention_days days)"
    rclone purge "$deleted_remote/$folder" || fail "could not purge $deleted_remote/$folder"
    purged=$((purged + 1))
  fi
done < <(rclone lsf "$deleted_remote" --dirs-only 2>/dev/null || true)

# Count both sides. A backup that silently copied nothing because the source
# remote pointed at an empty bucket would otherwise look identical to a
# healthy no-op night.
source_count="$(rclone size "$source_remote" --json | sed -n 's/.*"count":\([0-9]*\).*/\1/p')"
backup_count="$(rclone size "$rclone_remote" --json | sed -n 's/.*"count":\([0-9]*\).*/\1/p')"
echo "objects in store: ${source_count:-?}, objects in backup: ${backup_count:-?}"

[ -n "$source_count" ] || fail "could not count objects in $source_remote"
[ "$source_count" -gt 0 ] || fail "$source_remote reports zero objects — refusing to call that a successful backup"
# The backup may legitimately hold MORE than the store (it keeps the store
# objects sweeps and deletes removed; deleted photos sit outside it); fewer
# means this run did not finish its job.
[ "${backup_count:-0}" -ge "$source_count" ] || fail "backup holds $backup_count objects, fewer than the store's $source_count"

ping_healthcheck
record_run true "ok objects=${source_count} backup=${backup_count} remote=${rclone_remote} purged_days=${purged}"
echo "Object store backup complete."
