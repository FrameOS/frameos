-- Pre-Phase-3b design changes (cloud/docs/accounting-todo.md §9.3, 2026-09-02).
--
-- 1. `subscription_periods.recognized_micros`: how much of the period's
--    price has been recognised as revenue SO FAR. Recognition used to be one
--    entry at period end, which made a calendar-month P&L lag by up to a
--    month (a Maker month taken on the 20th showed no revenue until the
--    20th of the next month). The nightly job now recognises each period
--    daily, pro rata by whole days served, and this column is the cursor
--    that makes that step idempotent: tonight's entry is `earned so far −
--    recognized_micros`, and a night that runs twice finds nothing left.
--    Every period that exists today was recognised whole at its end or is
--    still deferred whole, so 0 is the honest backfill for all of them.
--
-- 2. `billing_settings.shared_key_daily_cap_micros` needs no seed row: when
--    absent it falls back to `payg_daily_cap_micros`, so nothing changes
--    until an operator sets it (settings.ts).

ALTER TABLE "subscription_periods"
  ADD COLUMN "recognized_micros" bigint NOT NULL DEFAULT 0 CHECK ("recognized_micros" >= 0);
