#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Deletes objects in the blob store that no database row points at.
#
# The app already deletes an object when the last row referencing it goes
# (deleteBlobIfUnreferenced in apps/auth-web/src/lib/blobs.ts). What it cannot
# see is a row that disappears underneath it: a `delete from accounts` cascades
# through scenes, versions, images and frames without any application code
# running, and every object those rows pointed at is orphaned in the same
# instant. This is the sweep for that.
#
# Account deletion removes the account's photos and frame snapshots itself
# (apps/auth-web/src/lib/account-erasure.ts); what is left for this sweep is
# the content-addressed store objects, and anything a failed delete left
# behind.
#
# DRY RUN BY DEFAULT — pass --apply to delete. Production runs it weekly with
# --apply as frameos-cloud-object-sweep.timer (cloud/ops/cleanup/install.sh,
# docs/operational-runbooks.md).
#
#   DATABASE_URL=... ./scripts/object-store-sweep.sh [--apply] [--force]
#
# Needs `rclone` with an `r2` remote (cloud/ops/backup/rclone.conf.example),
# or the app's own R2_CLOUD_* environment, which the timer's unit loads from
# auth-web.env (no second copy of the key to rotate).
# Deliberately not Node: this belongs with the other ops chores, and the
# release bundle carries no third-party node_modules to import from anyway.

apply=false
force=false
for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    # Delete even when most of the bucket looks orphaned (see below).
    --force) force=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Without an `r2` remote in an rclone.conf, build it from the app's
# environment: rclone reads a remote from RCLONE_CONFIG_<NAME>_* variables.
if ! rclone listremotes 2>/dev/null | grep -qx 'r2:' &&
  [ -n "${R2_CLOUD_ENDPOINT:-}" ] && [ -n "${R2_CLOUD_ACCESS_KEY_ID:-}" ] &&
  [ -n "${R2_CLOUD_SECRET_ACCESS_KEY:-}" ]; then
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_REGION=auto
  export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG_R2_ENDPOINT="$R2_CLOUD_ENDPOINT"
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_CLOUD_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_CLOUD_SECRET_ACCESS_KEY"
fi

# The URL never goes on a command line (ps / /proc show argv to every local
# account): it becomes libpq's PG* environment and psql runs bare.
# shellcheck source=scripts/lib/pg-env.sh
. scripts/lib/pg-env.sh
pg_env_from_url "${DATABASE_URL:-postgres://frameos_cloud:frameos_cloud@localhost:5432/frameos_cloud}"
remote="${OBJECT_STORE_REMOTE:-r2:${R2_CLOUD_BUCKET:-frameos-cloud}}"
# An object younger than this is never a candidate, however unreferenced it
# looks. A publish writes the object BEFORE the row that points at it, so a
# sweep racing a publish would otherwise delete the bytes of a scene that is
# mid-publish. Nothing else in the design needs this window to be long.
min_age="${OBJECT_STORE_SWEEP_MIN_AGE:-7d}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Listing objects in $remote older than $min_age"
rclone lsf "$remote" --recursive --files-only --min-age "$min_age" \
  | LC_ALL=C sort > "$work/stored"

# Uploads nobody saved. The owner image route registers bytes before a
# version binds them; a draft that was abandoned leaves a store_images row
# with no store_scene_version_images link, and the app never deletes those.
# Old enough unbound rows go first, so their objects show up as orphans
# below. Same age floor as the objects: a Save in flight has its row and its
# link written together, and a week-old unbound row is not mid-anything.
unbound_sql="
  delete from store_images i
   where i.created_at < now() - interval '7 days'
     and not exists (select 1 from store_scene_version_images vi where vi.image_sha256 = i.sha256)
     and not exists (select 1 from store_scenes s where s.preview_object_key = i.object_key)"
unbound_count="$(psql -Atq -v ON_ERROR_STOP=1 -c \
  "select count(*) from store_images i
    where i.created_at < now() - interval '7 days'
      and not exists (select 1 from store_scene_version_images vi where vi.image_sha256 = i.sha256)
      and not exists (select 1 from store_scenes s where s.preview_object_key = i.object_key)")"
if [ "$apply" = true ] && [ "$unbound_count" != "0" ]; then
  echo "Deleting $unbound_count unbound store_images rows older than 7 days"
  psql -Atq -v ON_ERROR_STOP=1 -c "$unbound_sql" >/dev/null
else
  echo "unbound store_images rows older than 7 days: $unbound_count (deleted with --apply)"
fi

echo "Listing referenced keys in the database"
psql -Atq -v ON_ERROR_STOP=1 > "$work/referenced" <<'SQL'
SELECT object_key FROM store_scene_versions WHERE object_key IS NOT NULL
UNION
SELECT preview_object_key FROM store_scenes WHERE preview_object_key IS NOT NULL
UNION
SELECT object_key FROM store_scene_images WHERE object_key IS NOT NULL
UNION
SELECT object_key FROM store_images
UNION
SELECT object_key FROM frame_asset_files WHERE object_key IS NOT NULL
UNION
-- Photos (docs/photos.md): the file and its thumbnail. Leave
-- these out and --apply deletes every photo in the library as an orphan.
SELECT object_key FROM photo_entries WHERE object_key IS NOT NULL
UNION
SELECT thumb_object_key FROM photo_entries WHERE thumb_object_key IS NOT NULL;
SQL
LC_ALL=C sort -o "$work/referenced" "$work/referenced"

comm -23 "$work/stored" "$work/referenced" > "$work/orphans"

stored_count="$(wc -l < "$work/stored" | tr -d ' ')"
referenced_count="$(wc -l < "$work/referenced" | tr -d ' ')"
orphan_count="$(wc -l < "$work/orphans" | tr -d ' ')"

echo "stored: $stored_count  referenced: $referenced_count  orphaned: $orphan_count"

if [ "$orphan_count" = "0" ]; then
  echo "Nothing to sweep."
  exit 0
fi

# An unattended --apply against the wrong database (an empty restore, a
# DATABASE_URL pointing elsewhere) would see every object as an orphan and
# delete the bucket. Real orphans are a sliver of it: more than a quarter of
# the stored objects is a reason to stop and look, not to delete.
if [ "$apply" = true ] && [ "$force" = false ] &&
  { [ "$referenced_count" = "0" ] || [ $((orphan_count * 4)) -gt "$stored_count" ]; }; then
  echo "Refusing to delete $orphan_count of $stored_count objects (referenced: $referenced_count): is DATABASE_URL the right database? Re-run with --force if this is really what you want." >&2
  exit 1
fi

# A referenced key that is somehow NOT in the store is the interesting failure
# — a row pointing at bytes that are gone — so say so rather than let a sweep
# report look clean.
missing_count="$(comm -13 "$work/stored" "$work/referenced" | wc -l | tr -d ' ')"
if [ "$missing_count" != "0" ]; then
  echo "WARNING: $missing_count referenced key(s) are not in the store (or are newer than $min_age)."
fi

deleted=0
retained=0
while IFS= read -r key; do
  [ -n "$key" ] || continue
  # Re-check immediately before deleting: the listing above is a snapshot, and
  # a publish may have claimed this key since. Costs one indexed query per
  # orphan, and the orphan set is small by construction.
  still_referenced="$(psql -Atq -v ON_ERROR_STOP=1 -v key="$key" <<'SQL'
SELECT 1 WHERE EXISTS (
  SELECT 1 FROM store_scene_versions WHERE object_key = :'key'
  UNION ALL SELECT 1 FROM store_scenes WHERE preview_object_key = :'key'
  UNION ALL SELECT 1 FROM store_scene_images WHERE object_key = :'key'
  UNION ALL SELECT 1 FROM store_images WHERE object_key = :'key'
  UNION ALL SELECT 1 FROM frame_asset_files WHERE object_key = :'key'
  UNION ALL SELECT 1 FROM photo_entries WHERE object_key = :'key'
  UNION ALL SELECT 1 FROM photo_entries WHERE thumb_object_key = :'key'
);
SQL
)"
  if [ "$still_referenced" = "1" ]; then
    echo "  skip (claimed since listing): $key"
    continue
  fi
  if [ "$apply" = true ]; then
    # A bucket lock refuses the delete outright (cloud/docs/backups.md). That
    # is the lock doing its job, not a sweep failure: report it and carry on
    # rather than aborting the run under `set -e`.
    if rclone deletefile "$remote/$key"; then
      deleted=$((deleted + 1))
    else
      echo "  refused (retained by a bucket lock?): $key"
      retained=$((retained + 1))
    fi
  else
    echo "  would delete: $key"
  fi
done < "$work/orphans"

if [ "$apply" = true ]; then
  echo "Deleted $deleted object(s)."
  [ "$retained" = "0" ] || echo "$retained object(s) were refused — still under a bucket lock."
else
  echo
  echo "Dry run. Re-run with --apply to delete."
fi
