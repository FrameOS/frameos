-- A precomputed snapshot of what each account stores, for /admin/storage.
--
-- Counting it live is six aggregates per account over store_scene_versions,
-- store_images, client_backups, frame_logs, frame_metrics and
-- frame_asset_files; doing that for every account on every page load is a
-- page that gets slower the more the instance succeeds. The snapshot is
-- refreshed in the background (src/lib/storage-usage.ts) and the page reads
-- one indexed table.
--
-- It is a CACHE, not a ledger: nothing is enforced from it (the quota checks
-- still count live, in usage.ts), rows may be stale, and dropping the table
-- loses nothing a refresh cannot rebuild. computed_at is shown next to the
-- numbers so a stale figure never passes as a current one.
CREATE TABLE "account_storage_usage" (
  "account_id" uuid PRIMARY KEY NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  -- The quota buckets, straight from usage.ts (public scenes are free but
  -- still occupy disk, so the admin view counts them separately).
  "private_scene_bytes" bigint DEFAULT 0 NOT NULL,
  "public_scene_bytes" bigint DEFAULT 0 NOT NULL,
  "backup_bytes" bigint DEFAULT 0 NOT NULL,
  "backup_count" integer DEFAULT 0 NOT NULL,
  "frame_log_bytes" bigint DEFAULT 0 NOT NULL,
  -- Neither of these counts against any quota, and both are why an account
  -- can cost far more than its quota page suggests: retained metrics samples
  -- and the cached device-asset bytes (thumbnails, repeat downloads).
  "frame_metrics_bytes" bigint DEFAULT 0 NOT NULL,
  "frame_asset_bytes" bigint DEFAULT 0 NOT NULL,
  "total_bytes" bigint DEFAULT 0 NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- The page's only ordering: biggest first.
CREATE INDEX "account_storage_usage_total_idx" ON "account_storage_usage" ("total_bytes" DESC);
