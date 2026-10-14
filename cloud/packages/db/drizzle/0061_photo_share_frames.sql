-- A folder may have a share link per frame it plays on (docs/photos.md "Share
-- links"): "Install on frame" makes the frame its own link, which can be
-- deleted without touching the folder's general link or another frame's.
-- `frame_id` is NULL for a general link, as every existing row is; a deleted
-- frame leaves its link unbound rather than taking it along. The one-link-
-- per-folder unique index gives way to a plain lookup index.
ALTER TABLE "photo_shares" ADD COLUMN "frame_id" uuid REFERENCES "frames"("id") ON DELETE SET NULL;
DROP INDEX "photo_shares_account_path_unique";
CREATE INDEX "photo_shares_account_path_idx" ON "photo_shares" ("account_id", "path");
