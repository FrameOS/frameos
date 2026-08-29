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
# DRY RUN BY DEFAULT — pass --apply to delete. Run periodically (monthly is
# plenty; the waste is bounded by how often accounts are deleted), the same way
# db-cleanup.sh is run; see docs/operational-runbooks.md.
#
#   DATABASE_URL=... ./scripts/object-store-sweep.sh [--apply]
#
# Needs `rclone` with an `r2` remote (cloud/ops/backup/rclone.conf.example).
# Deliberately not Node: this belongs with the other ops chores, and the
# release bundle carries no third-party node_modules to import from anyway.

apply=false
for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

database_url="${DATABASE_URL:-postgres://frameos_cloud:frameos_cloud@localhost:5432/frameos_cloud}"
remote="${OBJECT_STORE_REMOTE:-r2:frameos-cloud}"
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

echo "Listing referenced keys in the database"
psql "$database_url" -Atq -v ON_ERROR_STOP=1 > "$work/referenced" <<'SQL'
SELECT object_key FROM store_scene_versions WHERE object_key IS NOT NULL
UNION
SELECT preview_object_key FROM store_scenes WHERE preview_object_key IS NOT NULL
UNION
SELECT object_key FROM store_scene_images WHERE object_key IS NOT NULL
UNION
SELECT object_key FROM store_images
UNION
SELECT object_key FROM frame_asset_files WHERE object_key IS NOT NULL;
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
  still_referenced="$(psql "$database_url" -Atq -v ON_ERROR_STOP=1 -v key="$key" <<'SQL'
SELECT 1 WHERE EXISTS (
  SELECT 1 FROM store_scene_versions WHERE object_key = :'key'
  UNION ALL SELECT 1 FROM store_scenes WHERE preview_object_key = :'key'
  UNION ALL SELECT 1 FROM store_scene_images WHERE object_key = :'key'
  UNION ALL SELECT 1 FROM store_images WHERE object_key = :'key'
  UNION ALL SELECT 1 FROM frame_asset_files WHERE object_key = :'key'
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
