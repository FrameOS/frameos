-- What a photo carries besides its pixels (docs/photos.md "Metadata"): its
-- EXIF fields by group, its location (EXIF GPS, else XMP), and which other
-- blocks it holds (XMP, IPTC, comments, a trailer). Read from the bytes by
-- src/lib/photos/metadata.ts at upload, after a resize and after POST
-- /api/photos/metadata removes something. NULL means not read yet: a photo
-- stored before this, read in the background when its folder is listed or
-- on demand by GET /api/photos/metadata. Folders never have one. A listing's
-- pin is `metadata -> 'location'`; the share routes never send it.
ALTER TABLE "photo_entries" ADD COLUMN "metadata" jsonb;
