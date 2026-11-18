-- What a store scene needs of a frame (docs/scene-store.md "What a scene
-- needs"; frontend/src/utils/sceneNeeds.ts): `fast` (a fast screen: it
-- redraws more than once a second), `touch`, `keys`, `linux` (it runs a
-- program on a Linux frame). Read from the zip when a version is published,
-- like risk_flags and the icon.
--
--   store_scene_versions.needs — what that version's zip says.
--   store_scenes.needs — the projection of the latest version's, which every
--     listing reads (writeSceneVersion and syncLatestVersion keep it).
--
-- The versions before this column are read by
-- `pnpm --filter @frameos-cloud/auth-web scene:backfill-needs`.
--
-- The Real time shelf is gone with it (2026-11-18): a fast screen is what a
-- scene needs, not what it is about. Its scenes go to Fun & animations until
-- they name a category of their own; the new shelves (Clocks & time, Games)
-- need no change here.

ALTER TABLE "store_scene_versions"
  ADD COLUMN "needs" text[] DEFAULT '{}'::text[] NOT NULL;

ALTER TABLE "store_scenes"
  ADD COLUMN "needs" text[] DEFAULT '{}'::text[] NOT NULL;

UPDATE "store_scenes" SET "category" = 'fun' WHERE "category" = 'realtime';
UPDATE "store_scene_versions" SET "category" = 'fun' WHERE "category" = 'realtime';
