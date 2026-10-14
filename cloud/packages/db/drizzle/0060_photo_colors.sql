-- A photo's color profile (docs/photos.md "Colors"): the same object a frame
-- asset's `.frameos.json` sidecar holds under "colors" (exposure, whites and
-- blacks, tones, saturation, hue ranges, an optional dither palette). Set by
-- POST /api/photos/colors, stored as sent (at most 64 KB as JSON), sent to
-- frames with every file of a share link. NULL means no profile; folders
-- never have one. Moves and renames rewrite `path` only, so the profile
-- follows its photo, and a delete takes it with the row.
ALTER TABLE "photo_entries" ADD COLUMN "colors" jsonb;
