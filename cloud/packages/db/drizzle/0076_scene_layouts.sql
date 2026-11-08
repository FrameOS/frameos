-- Per-install layouts (docs/scene-layouts.md).
--
-- A layout is a regular scene marked `settings.isLayout` that draws other
-- scenes inside its chrome. Which layout an installed scene wears, and the
-- layout's settings for it, is the owner's choice for that install and must
-- survive an update of the scene to a newer version, so it is not scene
-- content (store versions are immutable zips) but a column on the assignment,
-- kept across the delete+insert that every assignment write is when the
-- caller omits it (the same rule as event_maps).
--
--   layouts — { [runtime scene id]: {sceneId, state?} }. Written by
--     buildScenesPayloadForFrame onto each scene as `layout` beside `nodes`,
--     which is what the device reads. NULL = none.

ALTER TABLE "frame_scene_assignments"
  ADD COLUMN "layouts" jsonb;

-- is_layout: every runtime scene of the assigned version is a layout. Settled
-- at each push while the version is open, so a voice turn can leave layouts
-- out of "what the frame shows" without unzipping every assigned version.

ALTER TABLE "frame_scene_assignments"
  ADD COLUMN "is_layout" boolean DEFAULT false NOT NULL;
