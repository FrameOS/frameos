-- A deep-sleeping battery frame announces its own sleep just before the CPU
-- halts (`sleep` frame → provider message): when it redials next, when the
-- panel refreshes next, and why it sleeps. Stored so the workspace can say
-- "asleep · wakes in 5 min" instead of "last seen just now" for a frame that
-- is gone for hours, and "overdue" when the wake never comes. All nullable:
-- older firmware never sends the message, and the hub clears next_wake_at /
-- sleep_reason again on every connect.
ALTER TABLE "frames"
  ADD COLUMN "next_wake_at" timestamptz,
  ADD COLUMN "next_render_at" timestamptz,
  ADD COLUMN "sleep_reason" text;
