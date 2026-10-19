-- The compiled scenes a frame reported in its `scenes_get` answer
-- (docs/cloud-frames.md, "Scenes the frame already had"), for the import
-- banner: [{id, name, sent}…], capped, names only. `sent` is true when the
-- payload holds the scene's JSON, which the owner can have converted to an
-- interpreted scene while importing; false for a scene the frame could only
-- name (compiled into its program by a backend's source build, so no JSON of
-- it is left on the frame). Older firmware only counts them
-- (`skipped_compiled`) and leaves this empty.
ALTER TABLE "frame_device_scenes" ADD COLUMN "compiled_scenes" jsonb DEFAULT '[]'::jsonb NOT NULL;
