-- A store scene's icon (docs/scene-icons.md): its main scene's
-- `settings.icon` (the scene marked default, else the first), one SVG path in
-- a 0 0 24 24 box, read when a version is published through the same rule
-- the SPA and the runtime use (frontend/src/utils/sceneIcon.ts). NULL = no
-- icon, or a value that is no icon. At most 1024 characters.
--
--   store_scene_versions.icon — what that version's zip says, recorded at
--     publish like risk_flags.
--   store_scenes.icon — the projection of the latest version's, which every
--     listing reads (writeSceneVersion and syncLatestVersion keep it).
--
-- No backfill here: a version published before scenes had icons holds none.
-- Versions published between the icon's release and this column are read by
-- `pnpm --filter @frameos-cloud/auth-web scene:backfill-icons`.

ALTER TABLE "store_scene_versions"
  ADD COLUMN "icon" text;

ALTER TABLE "store_scenes"
  ADD COLUMN "icon" text;
