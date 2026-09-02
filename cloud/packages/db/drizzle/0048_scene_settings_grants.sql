-- Per-install grants for the service settings a scene declares
-- (docs/security-todo.md, "Scene-declared settings groups are honoured
-- as-is", 2026-09-02).
--
-- A store scene's own bundled config.json `settings` list used to decide,
-- on its own, which of the owner's stored API keys reached the frame: the
-- assignment denormalized every declared group onto frames.service_setting_groups
-- and the device pull shipped all of them. Scene code is untrusted — a
-- published scene is anyone's code — so a declaration is a REQUEST, and the
-- owner grants or refuses it per assignment:
--
--   declared_settings_groups — what the assigned version's apps declare,
--     computed from the assembled payload at every assign / backfill.
--   granted_settings_groups  — what the owner allowed for this scene on
--     this frame. Always a subset of declared ∩ the deliverable groups.
--
-- NULL granted = a row assigned before this migration. It reads as
-- "granted = declared" so no frame that renders today loses its keys
-- overnight, and it turns into an explicit list the next time the owner
-- saves the frame's scene list (the workspace posts settings_groups for
-- every scene). A NEW assignment that names no groups grants nothing.
--
-- frames.service_setting_groups keeps its shape but changes meaning: it is
-- now the union of the GRANTED groups across the frame's assignments, which
-- is exactly what the device pull ships.

ALTER TABLE "frame_scene_assignments"
  ADD COLUMN "declared_settings_groups" jsonb,
  ADD COLUMN "granted_settings_groups" jsonb;
