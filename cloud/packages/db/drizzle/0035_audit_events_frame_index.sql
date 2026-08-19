-- Per-frame audit trail: events that concern a frame carry
-- target->>'frameId'. The frame workspace's Activity panel filters on it, so
-- give that lookup an index instead of a scan over the account's whole feed.
CREATE INDEX "audit_events_target_frame_idx"
  ON "audit_events" (("target"->>'frameId'), "created_at");
