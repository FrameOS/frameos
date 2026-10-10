-- The device's last `ota:<plane>` log line, folded into the frame row by the
-- hub (hub.ts recordFirmwareUpdate): {status, detail, plane, at, version?}.
-- Until now OTA progress existed only as log lines, and the frames list said
-- "waiting to sync" through a whole download. Cleared on the hello that
-- follows a verified install or reports a new version.
ALTER TABLE "frames" ADD COLUMN "firmware_update" jsonb;
