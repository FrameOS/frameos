-- Publisher-assigned tags for store scenes: short lowercase slugs used for
-- browsing/filtering on the store front and exposed in repository.json.
ALTER TABLE "store_scenes" ADD COLUMN IF NOT EXISTS "tags" text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS "store_scenes_tags_idx" ON "store_scenes" USING gin ("tags");
