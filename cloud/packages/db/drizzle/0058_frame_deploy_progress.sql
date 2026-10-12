-- How far the frame's current deploy / update / restart / reboot has come,
-- from the click to the first render on the new code: one record in the
-- vocabulary of docs/deploy-progress-contract.json ({id, kind, stage,
-- status, detail, progress, version, error, started_at, at}). Written by
-- enqueueFrameCommand (the start) and the hub (sent / acked / scene_ack /
-- hello / render / log lines). The self-hosted backend keeps the same column,
-- so the shared workspace draws one progress bar on both control planes.
ALTER TABLE "frames" ADD COLUMN "deploy_progress" jsonb;
