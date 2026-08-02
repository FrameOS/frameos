-- The FrameOS version a scene was exported with, read from the template.json
-- manifest at publish. Informational: the store surfaces it so people know
-- what a scene was built/tested on (and as a nudge to upgrade older devices).
ALTER TABLE "store_scenes" ADD COLUMN IF NOT EXISTS "frameos_version" text;
ALTER TABLE "store_scene_versions" ADD COLUMN IF NOT EXISTS "frameos_version" text;
