-- Store categories: one curated shelf per scene on the store front. Values
-- come from the fixed taxonomy in the app (storeCategories); null means not
-- yet categorized (auto-assigned on publish, backfillable from /admin/scenes).
ALTER TABLE "store_scenes" ADD COLUMN IF NOT EXISTS "category" text;
CREATE INDEX IF NOT EXISTS "store_scenes_category_idx" ON "store_scenes" ("category");
