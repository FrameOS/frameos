-- Sliding sessions. expires_at stops being a fixed lifetime stamped at login
-- and becomes an idle deadline that activity pushes forward;
-- absolute_expires_at is the ceiling no amount of activity can extend past,
-- so a session still ends in a real re-authentication. last_used_at records
-- the last time the row was extended, which lets the refresh throttle itself
-- (one write per session per hour) instead of touching the row per request.
--
-- Existing rows carry an 8 hour expires_at and a JWT that expires with it, so
-- backfilling the ceiling from created_at only affects sessions that would
-- have died on their own anyway.
ALTER TABLE "sessions"
	ADD COLUMN "last_used_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "sessions"
	ADD COLUMN "absolute_expires_at" timestamp with time zone;
UPDATE "sessions"
	SET "absolute_expires_at" = "created_at" + interval '90 days'
	WHERE "absolute_expires_at" IS NULL;
ALTER TABLE "sessions"
	ALTER COLUMN "absolute_expires_at" SET NOT NULL;
