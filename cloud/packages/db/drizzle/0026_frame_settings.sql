-- Last-pushed declarative settings (the allowedFrameSettings subset), stored
-- so the Settings panel renders current state instead of blanks after a
-- reload and so a push toward an offline device survives. The display name
-- stays in frames.name — it is never mirrored into this column.
ALTER TABLE "frames" ADD COLUMN "settings" jsonb;
