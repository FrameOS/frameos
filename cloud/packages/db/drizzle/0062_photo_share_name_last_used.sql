-- Custom-named share links next to a folder's general and per-frame ones
-- (docs/photos.md "Share links"), and when each link was last read through,
-- so the owner sees which are in use.
ALTER TABLE "photo_shares" ADD COLUMN "name" text;
ALTER TABLE "photo_shares" ADD COLUMN "last_used_at" timestamp with time zone;
