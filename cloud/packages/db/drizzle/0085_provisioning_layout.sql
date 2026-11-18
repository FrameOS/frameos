-- The layout a frame starts with, chosen where its SD card or ESP32 was
-- flashed (docs/scene-layouts.md "Chosen at the flash"). Carried on the claim
-- code like scene_source_frame_id, copied onto every frame it enrolls, and
-- installed when the frame turns active (src/lib/frame-provisioning.ts):
-- {"storeSceneId": uuid, "layout": {"sceneId": runtime id, "state"?: {...}}}.

ALTER TABLE "frame_enrollment_tokens" ADD COLUMN "provisioning_layout" jsonb;
ALTER TABLE "frames" ADD COLUMN "provisioning_layout" jsonb;
