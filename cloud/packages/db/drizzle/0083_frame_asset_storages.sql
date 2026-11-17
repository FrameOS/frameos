-- A frame's asset storages (docs/cloud-frames.md "Asset storages"): an
-- ESP32 has its assets folder (the TF card when one is mounted) and its
-- internal flash storage, and the asset verbs name which with an optional
-- `storage` ("assets" when absent). The cloud's two caches become per
-- storage, every existing row being the assets folder's:
--
--   frame_assets — one listing per (frame, storage), and `storages`, the
--     places the device said it has with that listing (null = it said
--     nothing: older firmware and Linux frames, the assets folder alone).
--   frame_asset_files — the fetched bytes, keyed by storage too, so a file
--     of one storage never answers for the same path on the other.

ALTER TABLE "frame_assets"
  ADD COLUMN "storage" text DEFAULT 'assets' NOT NULL;

ALTER TABLE "frame_assets"
  ADD COLUMN "storages" jsonb;

ALTER TABLE "frame_assets"
  DROP CONSTRAINT "frame_assets_pkey";

ALTER TABLE "frame_assets"
  ADD CONSTRAINT "frame_assets_pkey" PRIMARY KEY ("frame_id", "storage");

ALTER TABLE "frame_asset_files"
  ADD COLUMN "storage" text DEFAULT 'assets' NOT NULL;

DROP INDEX "frame_asset_files_frame_path_thumb_idx";

CREATE UNIQUE INDEX "frame_asset_files_frame_storage_path_thumb_idx"
  ON "frame_asset_files" ("frame_id", "storage", "path", "thumb");
