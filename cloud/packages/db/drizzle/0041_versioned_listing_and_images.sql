-- One version = scenes.json + the listing + the ordered image set.
--
-- Until now only scenes.json was versioned; description, tags, category and
-- the whole image gallery lived on the scene row, mutable underneath every
-- published version. This records them per version — the listing as
-- columns on store_scene_versions (and inside the zip's template.json from
-- now on), the images as content-addressed rows linked from each version
-- in order. Position 0 of a version's set is its cover.
--
-- Nothing already published is rewritten: no zip changes, every recorded
-- sha256 stays valid. Only each scene's LATEST version gets today's listing
-- and image set stamped onto it (listing_recorded = true); older versions
-- keep no record and readers fall back to the scene row for them. The
-- store_scenes listing columns stay, as the projection of the latest
-- version — the store's SQL filters, orders and searches on them and cannot
-- read a zip. store_scene_images and store_scenes.preview_* stay in place
-- but are no longer read or written.

ALTER TABLE "store_scene_versions"
  ADD COLUMN "description" text,
  ADD COLUMN "tags" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "category" text,
  ADD COLUMN "listing_recorded" boolean NOT NULL DEFAULT false;

CREATE TABLE "store_images" (
  "sha256" text PRIMARY KEY,
  "object_key" text NOT NULL,
  "content_type" text NOT NULL DEFAULT 'image/jpeg',
  "size_bytes" integer NOT NULL,
  "width" integer,
  "height" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "store_scene_version_images" (
  "version_id" uuid NOT NULL REFERENCES "store_scene_versions"("id") ON DELETE CASCADE,
  "image_sha256" text NOT NULL REFERENCES "store_images"("sha256"),
  "position" integer NOT NULL,
  PRIMARY KEY ("version_id", "position")
);
CREATE INDEX "store_scene_version_images_image_idx"
  ON "store_scene_version_images" ("image_sha256");

-- The image rows below take their digest from the object key, so every
-- image must already be in object storage. Rows still holding their bytes
-- in Postgres (pre-0032, never walked across) have no key to read; refuse
-- rather than silently drop them from the backfill.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "store_scene_images" WHERE "object_key" IS NULL)
     OR EXISTS (SELECT 1 FROM "store_scenes" WHERE "preview_object_key" IS NULL AND "preview_image" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'store images still hold bytes in Postgres: run cloud/scripts/backfill-object-store.mjs before migration 0041';
  END IF;
END $$;

-- The latest version of every scene records the listing as it stands.
UPDATE "store_scene_versions" v
   SET "description" = s."description",
       "tags" = s."tags",
       "category" = s."category",
       "listing_recorded" = true
  FROM "store_scenes" s
 WHERE s."id" = v."scene_id"
   AND v."version" = s."latest_version";

-- Every preview and gallery image becomes one content-addressed row. The
-- preview came with dimensions (from the zip manifest); gallery uploads did
-- not record theirs.
INSERT INTO "store_images" ("sha256", "object_key", "content_type", "size_bytes", "width", "height", "created_at")
SELECT substring("preview_object_key" from '[0-9a-f]{64}'),
       "preview_object_key",
       coalesce("preview_image_type", 'image/jpeg'),
       coalesce("preview_image_size_bytes", 0),
       "preview_image_width",
       "preview_image_height",
       "created_at"
  FROM "store_scenes"
 WHERE "preview_object_key" IS NOT NULL
ON CONFLICT ("sha256") DO NOTHING;

INSERT INTO "store_images" ("sha256", "object_key", "content_type", "size_bytes", "created_at")
SELECT substring("object_key" from '[0-9a-f]{64}'),
       "object_key",
       "content_type",
       coalesce("size_bytes", 0),
       "created_at"
  FROM "store_scene_images"
 WHERE "object_key" IS NOT NULL
ON CONFLICT ("sha256") DO NOTHING;

-- The latest version's image set: the publish-time preview leads when there
-- is one, then the gallery in its order — which is exactly what the scene
-- page showed. The same bytes twice collapse to one link.
WITH ordered AS (
  SELECT v."id" AS version_id,
         substring(s."preview_object_key" from '[0-9a-f]{64}') AS sha,
         0 AS tier,
         0::bigint AS seq
    FROM "store_scenes" s
    JOIN "store_scene_versions" v ON v."scene_id" = s."id" AND v."version" = s."latest_version"
   WHERE s."preview_object_key" IS NOT NULL
  UNION ALL
  SELECT v."id",
         substring(i."object_key" from '[0-9a-f]{64}'),
         1,
         row_number() OVER (PARTITION BY i."scene_id" ORDER BY i."position", i."created_at")
    FROM "store_scene_images" i
    JOIN "store_scenes" s ON s."id" = i."scene_id"
    JOIN "store_scene_versions" v ON v."scene_id" = s."id" AND v."version" = s."latest_version"
   WHERE i."object_key" IS NOT NULL
), deduped AS (
  SELECT version_id, sha, tier, seq,
         row_number() OVER (PARTITION BY version_id, sha ORDER BY tier, seq) AS occurrence
    FROM ordered
)
INSERT INTO "store_scene_version_images" ("version_id", "image_sha256", "position")
SELECT version_id,
       sha,
       row_number() OVER (PARTITION BY version_id ORDER BY tier, seq) - 1
  FROM deduped
 WHERE occurrence = 1;
