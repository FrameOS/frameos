#!/usr/bin/env bash
set -euo pipefail

# Restore drill: proves the nightly logical dump can actually be restored and
# that what comes out is the whole database, not a plausible-looking subset.
#
# An untested backup is a hypothesis. This is the test. It never touches the
# live database — everything lands in a scratch database that is dropped
# again at the end (--keep leaves it for poking around).
#
# Where to run it:
#
#   On the prod box   sudo -u postgres RCLONE_CONFIG=/root/.config/rclone/rclone.conf \
#                       /path/to/restore-drill.sh
#                     (needs rclone's config; the postgres user has no copy)
#
#   Off-box, e.g. a   sudo -u postgres ./restore-drill.sh --sftp \
#   throwaway VM        --sftp-key /path/to/hetzner-storage.key
#                     Fetches over SFTP so no rclone config is required. Use
#                     this shape for the quarterly drill: it also proves the
#                     backups are readable from somewhere that is not the box
#                     that wrote them, which is the case that matters when
#                     the box is the thing that died.
#
#   Against a file    ./restore-drill.sh --dump /var/backups/frameos-cloud/db-<stamp>.dump
#
# Exit status is the drill result: 0 = restored and verified, non-zero = the
# backups are NOT known-good and someone has to look. Findings and the full
# procedure live in cloud/docs/backups.md.

scratch_db="${DRILL_DATABASE:-frameos_cloud_restore_test}"
rclone_remote="${RCLONE_REMOTE:-storagebox:frameos-cloud-backups}"
sftp_host="${STORAGE_BOX_SFTP:-u651211@u651211.your-storagebox.de}"
sftp_port="${STORAGE_BOX_SFTP_PORT:-23}"
sftp_path="${STORAGE_BOX_SFTP_PATH:-frameos-cloud-backups}"
sftp_key="${STORAGE_BOX_SSH_KEY:-}"
dump_file=""
fetch_mode="rclone"
keep=false
work_dir=""

usage() {
  sed -n '4,32p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dump) dump_file="${2:?--dump needs a path}"; fetch_mode="file"; shift 2 ;;
    --remote) rclone_remote="${2:?--remote needs an rclone remote}"; shift 2 ;;
    --sftp) fetch_mode="sftp"; shift ;;
    --sftp-key) sftp_key="${2:?--sftp-key needs a path}"; fetch_mode="sftp"; shift 2 ;;
    --database) scratch_db="${2:?--database needs a name}"; shift 2 ;;
    --keep) keep=true; shift ;;
    -h | --help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

# The whole point is that this cannot eat production. The scratch name must
# look like a scratch name, and dropdb below only ever sees this value.
case "$scratch_db" in
  *restore_test* | *drill*) ;;
  *)
    echo "refusing to use '$scratch_db': the scratch database name must contain 'restore_test' or 'drill'" >&2
    exit 2
    ;;
esac

for tool in psql pg_restore createdb dropdb; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

cleanup() {
  if [ "$keep" = false ]; then
    dropdb --if-exists "$scratch_db" 2>/dev/null || true
  fi
  # Only ever removes the directory this run created.
  [ -n "$work_dir" ] && rm -rf "$work_dir"
}
trap cleanup EXIT

started_at="$(date -u +%FT%TZ)"
echo "== FrameOS Cloud restore drill: $started_at"

# --- 1. get a dump -----------------------------------------------------------

case "$fetch_mode" in
  file)
    [ -r "$dump_file" ] || { echo "cannot read dump: $dump_file" >&2; exit 2; }
    ;;
  rclone)
    command -v rclone >/dev/null || {
      echo "rclone not found — pass --dump FILE or use --sftp" >&2
      exit 2
    }
    work_dir="$(mktemp -d)"
    newest="$(rclone lsf "$rclone_remote" --include 'db-*.dump' | sort | tail -1)"
    [ -n "$newest" ] || { echo "no db-*.dump found in $rclone_remote" >&2; exit 2; }
    echo "-- fetching $newest from $rclone_remote"
    rclone copy "$rclone_remote/$newest" "$work_dir"
    dump_file="$work_dir/$newest"
    ;;
  sftp)
    work_dir="$(mktemp -d)"
    sftp_opts=(-q -P "$sftp_port" -o BatchMode=yes)
    [ -n "$sftp_key" ] && sftp_opts+=(-i "$sftp_key")
    # sftp echoes each command back as "sftp> ls -1 …" before its output, so
    # the echoed glob would otherwise be picked up as a filename.
    newest="$(
      printf 'cd %s\nls -1 db-*.dump\n' "$sftp_path" |
        sftp "${sftp_opts[@]}" "$sftp_host" 2>/dev/null |
        grep -v '^sftp>' | tr -d '\r' | sed 's#.*/##' |
        grep '^db-.*\.dump$' | sort | tail -1
    )"
    [ -n "$newest" ] || { echo "no db-*.dump found on $sftp_host:$sftp_path" >&2; exit 2; }
    echo "-- fetching $newest over sftp from $sftp_host"
    sftp "${sftp_opts[@]}" "$sftp_host:$sftp_path/$newest" "$work_dir/" >/dev/null
    dump_file="$work_dir/$newest"
    ;;
esac

dump_size="$(du -h "$dump_file" | cut -f1)"
echo "-- dump: $dump_file ($dump_size)"

# Reads the whole TOC; fails on a truncated or corrupt archive without
# touching any database. Same gate the nightly job applies before upload —
# repeated here because this copy made a round trip through the Storage Box.
pg_restore --list "$dump_file" >/dev/null
toc_entries="$(pg_restore --list "$dump_file" | grep -c '^[0-9]')"
echo "-- TOC readable: $toc_entries entries"

# --- 2. restore into a scratch database --------------------------------------

echo "-- restoring into $scratch_db"
dropdb --if-exists "$scratch_db"
createdb "$scratch_db"

restore_log="$(mktemp)"
restore_status=0
# --no-owner/--no-privileges: the drill host has no frameos_cloud role and
# does not need one; ownership is a property of the target box, not of the
# data being verified. Errors are counted rather than fatal so the report
# below still runs and shows how far the restore got.
pg_restore --no-owner --no-privileges --exit-on-error \
  -d "$scratch_db" "$dump_file" >"$restore_log" 2>&1 || restore_status=$?
restore_errors="$(grep -ci 'error' "$restore_log" || true)"
if [ "$restore_status" -ne 0 ]; then
  echo "!! pg_restore exited $restore_status; last lines:" >&2
  tail -20 "$restore_log" >&2
fi
rm -f "$restore_log"
echo "-- pg_restore exit=$restore_status errors=$restore_errors"

# --- 3. verify what landed ---------------------------------------------------

# Row counts alone would pass on a dump whose bytea columns were truncated,
# so the blob tables are summed by length(): that forces Postgres to read
# every byte back out of the restored TOAST storage.
echo "-- contents"
psql -d "$scratch_db" -v ON_ERROR_STOP=1 --pset=pager=off <<'SQL'
SELECT 'accounts' AS table, count(*) AS rows FROM accounts
UNION ALL SELECT 'account_identities', count(*) FROM account_identities
UNION ALL SELECT 'sessions', count(*) FROM sessions
UNION ALL SELECT 'linked_clients', count(*) FROM linked_clients
UNION ALL SELECT 'frames', count(*) FROM frames
UNION ALL SELECT 'frame_assets', count(*) FROM frame_assets
UNION ALL SELECT 'store_scenes', count(*) FROM store_scenes
UNION ALL SELECT 'store_scene_versions', count(*) FROM store_scene_versions
UNION ALL SELECT 'audit_events', count(*) FROM audit_events
ORDER BY 1;

SELECT count(*) AS migrations, max(applied_at) AS last_migration FROM schema_migrations;

SELECT
  pg_size_pretty(sum(length(content))::bigint) AS scene_image_bytes,
  count(*) AS scene_images
FROM store_scene_images;

SELECT
  pg_size_pretty(coalesce(sum(length(content)), 0)::bigint) AS asset_file_bytes,
  count(*) AS asset_files
FROM frame_asset_files;

SELECT max(created_at) AS newest_account FROM accounts;
SELECT max(created_at) AS newest_audit_event FROM audit_events;
SQL

# Assertions: an empty-but-valid restore is the failure mode a human eyeballing
# the numbers above is most likely to wave through, so make it exit non-zero.
echo "-- assertions"
failures="$(
  psql -d "$scratch_db" -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT string_agg(problem, '; ')
FROM (
  SELECT 'no accounts restored' AS problem WHERE (SELECT count(*) FROM accounts) = 0
  UNION ALL
  SELECT 'no identities restored' WHERE (SELECT count(*) FROM account_identities) = 0
  UNION ALL
  SELECT 'no migrations recorded' WHERE (SELECT count(*) FROM schema_migrations) = 0
  UNION ALL
  SELECT 'scene image bytes are null/zero despite scene image rows'
    WHERE (SELECT count(*) FROM store_scene_images) > 0
      AND (SELECT coalesce(sum(length(content)), 0) FROM store_scene_images) = 0
  UNION ALL
  -- A dump taken while the app was mid-write would still restore; a dump
  -- taken from the wrong (empty/dev) database would not have real history.
  SELECT 'newest account is older than 400 days — is this the right database?'
    WHERE (SELECT max(created_at) FROM accounts) < now() - interval '400 days'
) AS problems;
SQL
)"

if [ -n "$failures" ] || [ "$restore_status" -ne 0 ]; then
  echo "DRILL FAILED: ${failures:-pg_restore exited $restore_status}" >&2
  exit 1
fi

echo "DRILL PASSED: $(basename "$dump_file") restored and verified at $(date -u +%FT%TZ)"
[ "$keep" = true ] && echo "(scratch database $scratch_db kept; drop it with: dropdb $scratch_db)"
exit 0
