-- The service-settings groups ("unsplash", "openAI", …) the frame's assigned
-- scenes declare, denormalized off the scene payloads. Recomputing it unzips
-- every assigned scene version, so it is written where scenes are assigned
-- and read on every device pull of /api/frames/{id}/service-settings. NULL
-- means "never computed" — the pull route computes and backfills it once.
-- Group NAMES only; API keys never land in this column (or in any frames row).
ALTER TABLE "frames" ADD COLUMN "service_setting_groups" jsonb;
