-- Per-install button maps (docs/events.md, "Event map").
--
-- A frame has the keys it has (a reTerminal's LEFT, RIGHT, REFRESH) and a
-- store scene listens for the ones its author had (A, B, C, D). The owner
-- remaps them per INSTALLED scene — "Map buttons" in the scene's menu — and
-- the map must survive an update of the scene to a newer version, so it is
-- not scene content (store versions are immutable zips) but a column on the
-- assignment, kept across the delete+insert that every assignment write is
-- when the caller omits it (the same "omitted = keep" rule as
-- granted_settings_groups).
--
--   event_maps — { [runtime scene id]: [ {event, match, as}, … ] }: one list
--     of rules per runtime scene of the assigned version (a pack has
--     several). buildScenesPayloadForFrame writes each list onto its scene
--     as `eventMap` beside `nodes`, which is what the device reads. NULL =
--     no map.

ALTER TABLE "frame_scene_assignments"
  ADD COLUMN "event_maps" jsonb;
