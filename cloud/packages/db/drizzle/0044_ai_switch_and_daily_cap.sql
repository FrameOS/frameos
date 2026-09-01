-- Phase 3a of cloud/docs/accounting-todo.md: the two things that make the AI
-- metering we already run visible and controllable to the people it measures,
-- neither of which needs a payment provider.
--
-- 1. The AI switch (§5.1). An account may opt out of AI features entirely and
--    then incur nothing. A column on `accounts` rather than an
--    `account_settings` row: that table holds per-group string maps written by
--    the shared frontend settings form, which posts whole objects and is the
--    wrong owner for a switch that must never be flipped by accident. This is
--    the same kind of per-account product flag as `store_banned_at`, and a
--    timestamp answers "since when" for free where a boolean would not.
ALTER TABLE "accounts" ADD COLUMN "ai_disabled_at" timestamptz;

-- 2. The daily cap (§5.3). Postpay's one real cost is credit risk, and the cap
--    is how it is bounded: $10/day per account to start. A setting rather than
--    a constant so it is a superadmin edit at /admin/billing, not a deploy.
INSERT INTO "billing_settings" ("key", "value") VALUES
  ('payg_daily_cap_micros', '10000000')
ON CONFLICT ("key") DO NOTHING;

-- The cap sums a UTC day of an account's usage on the hot path of every turn,
-- and the /account/ai page sums a month of it. `ai_usage_records_account_created_idx`
-- is on (account_id, created_at); both queries filter on `occurred_at`, which is
-- when the tokens were burned rather than when the row was written — the
-- distinction that matters for a turn metered by the sweep hours later.
CREATE INDEX "ai_usage_records_account_occurred_idx"
  ON "ai_usage_records" ("account_id", "occurred_at");
