-- Blobs move out of Postgres and into object storage (R2 in production, a
-- directory under db/object-storage in development). docs/todo.md, "Store":
-- the ~100 MB/account cap made bytea fine at launch, and the stored sha256 +
-- size_bytes were kept precisely so the move would be mechanical.
--
-- The shape is the same for all four tables: keep the existing `content`
-- column, make it nullable, and add an `object_key` beside it. Exactly one of
-- the two is set per row. Nothing is rewritten here — rows published before
-- this migration keep their bytes in Postgres and keep working, and
-- scripts/backfill-object-store.mjs walks them across whenever it is
-- convenient. That is what makes this migration safe to apply under a running
-- deployment: no read path changes meaning at the instant it runs.
--
-- Two size columns appear as well. Once bytes live elsewhere,
-- `octet_length(content)` stops being able to answer "how much storage does
-- this account use" (lib/usage.ts), so the size is recorded at write time on
-- the two tables that had no size column of their own. store_scene_versions
-- and frame_asset_files already carried one.

ALTER TABLE "store_scene_versions"
  ALTER COLUMN "content" DROP NOT NULL,
  ADD COLUMN "object_key" text;

ALTER TABLE "store_scenes"
  ADD COLUMN "preview_object_key" text,
  ADD COLUMN "preview_image_size_bytes" integer;

ALTER TABLE "store_scene_images"
  ALTER COLUMN "content" DROP NOT NULL,
  ADD COLUMN "object_key" text,
  ADD COLUMN "size_bytes" integer;

ALTER TABLE "frame_asset_files"
  ALTER COLUMN "content" DROP NOT NULL,
  ADD COLUMN "object_key" text;

-- Legacy rows get their size backfilled in place: cheap (octet_length reads
-- the toast header, not the blob) and it lets usage accounting switch to the
-- column unconditionally instead of branching per row.
UPDATE "store_scenes"
   SET "preview_image_size_bytes" = octet_length("preview_image")
 WHERE "preview_image" IS NOT NULL
   AND "preview_image_size_bytes" IS NULL;

UPDATE "store_scene_images"
   SET "size_bytes" = octet_length("content")
 WHERE "content" IS NOT NULL
   AND "size_bytes" IS NULL;

-- "Is any row still pointing at this object?" runs on every delete of a
-- content-addressed blob (blobs.ts deleteBlobIfUnreferenced), and the answer
-- must not be a sequential scan of a table full of blobs.
CREATE INDEX IF NOT EXISTS "store_scene_versions_object_key_idx"
  ON "store_scene_versions" ("object_key");
CREATE INDEX IF NOT EXISTS "store_scenes_preview_object_key_idx"
  ON "store_scenes" ("preview_object_key");
CREATE INDEX IF NOT EXISTS "store_scene_images_object_key_idx"
  ON "store_scene_images" ("object_key");
CREATE INDEX IF NOT EXISTS "frame_asset_files_object_key_idx"
  ON "frame_asset_files" ("object_key");
