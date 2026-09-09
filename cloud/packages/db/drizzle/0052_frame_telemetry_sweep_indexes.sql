-- Two hot paths on the device plane that ran without a usable index.
--
-- The hub's 30 s sweep expires every pending/sent command whose TTL has
-- passed, fleet-wide: `where status in ('pending','sent') and expires_at <
-- now()`. The only index led with frame_id, so that was a sequential scan of
-- frame_commands every 30 s. Partial on the two live states, ordered by the
-- deadline, so the sweep reads exactly the rows it will touch.
CREATE INDEX "frame_commands_live_expires_idx"
  ON "frame_commands" ("expires_at")
  WHERE "status" IN ('pending', 'sent') AND "expires_at" IS NOT NULL;

-- Every device log batch runs an account-wide SUM(size_bytes) over frame_logs
-- inside its insert transaction (usage.ts frameLogBytesForAccount /
-- cullFrameLogsForFrameOverBudget: frames by account, then each frame's
-- rows). frame_logs_frame_idx (frame_id, id) found the rows but not the
-- column, so every sum went back to the heap. Carrying size_bytes lets the
-- planner answer from the index alone.
CREATE INDEX "frame_logs_frame_size_idx"
  ON "frame_logs" ("frame_id", "size_bytes");
