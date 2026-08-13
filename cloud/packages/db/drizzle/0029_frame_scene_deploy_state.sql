-- Per-scene deploy tracking for cloud-managed frames. assigned_checksum /
-- scenes_checksum cover the WHOLE assigned set, so the workspace could only
-- say "something differs", never which scene. assigned_scene_state records,
-- per store scene, {version, checksum} of the slice the last assignment push
-- contained; the hub copies it into deployed_scene_state the moment the
-- device acknowledges the matching set checksum. deployed_scene_state is the
-- cloud's equivalent of the self-hosted backend's
-- last_successful_deploy.scenes: what the device is actually running, per
-- scene. NULL on frames that predate the column; the UI falls back to the
-- old all-or-nothing behavior until the next push backfills it.
ALTER TABLE "frames"
  ADD COLUMN "assigned_scene_state" jsonb,
  ADD COLUMN "deployed_scene_state" jsonb;
