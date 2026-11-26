-- Service keys per installed scene (docs/service-keys.md).
--
-- A frame used to be sent the union of what its installs were granted, so a
-- store scene nobody granted OpenAI read the key anyway when another scene on
-- the same frame used it. A frame is now sent each runtime scene's own
-- bindings (`serviceKeys` beside `settings` in the service-settings pull), so
-- the cloud needs, without unzipping every assigned version on each pull:
--
--   scene_services — { [runtime scene id]: [service, …] }: what each runtime
--     scene of the assigned version declares. Settled where the version is
--     already open (buildScenesPayloadForFrame), like declared_settings_groups
--     and is_layout. NULL = a row from before this column: the pull settles it
--     once, as it does for frames.service_setting_groups.
--
--   service_keys — { [runtime scene id]: {service: "default" | credential id
--     | null} }: the owner's choice of key for each service, the install's and
--     never the scene's. Kept across the delete+insert every assignment write
--     is when the caller omits it (the rule of event_maps and layouts). NULL
--     = none chosen: the grant (granted_settings_groups) decides, the default
--     key for what it covers and nothing otherwise.

ALTER TABLE "frame_scene_assignments"
  ADD COLUMN "scene_services" jsonb;

ALTER TABLE "frame_scene_assignments"
  ADD COLUMN "service_keys" jsonb;
