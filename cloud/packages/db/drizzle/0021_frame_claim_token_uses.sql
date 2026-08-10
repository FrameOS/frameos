-- Multi-use claim tokens (docs/cloud-frames.md "Multi-use claim tokens"):
-- one personalized SD image flashed to many cards enrolls many frames.
-- use_count is bumped atomically per enrollment; used_at is set when the
-- budget is spent, keeping db-cleanup.sh's retention query working.
ALTER TABLE "frame_enrollment_tokens" ADD COLUMN "max_uses" integer DEFAULT 1 NOT NULL;
ALTER TABLE "frame_enrollment_tokens" ADD COLUMN "use_count" integer DEFAULT 0 NOT NULL;
