-- Accounting review fixes (cloud/docs/accounting-todo.md §9, 2026-09-02).
-- Five small schema changes, each one the data half of a bug in §9.2.
--
--  1. `subscriptions.account_id` loses its foreign key. Migration 0045
--     declared it `REFERENCES accounts ON DELETE CASCADE`, which broke the
--     rule every other billing table follows (§2.1, no foreign key points
--     out of the accounting module) and, worse, meant deleting a subscriber
--     mid-period cascaded away the charged-but-unrecognised period row —
--     leaving a balance in liability:deferred:subscriptions that nothing
--     would ever recognise or refund. The uuid stays; the reference goes.
--     The schema test now covers every billing table, so this cannot come
--     back quietly.
--  2. `subscriptions.next_plan_code`: a downgrade takes effect at the next
--     rollover rather than instantly (§9.2 item 6). The row keeps the plan
--     the account is on until then and names the one it moves to.
--  3. `subscription_periods.refunded_micros`: what §3.6's refund recipe has
--     already returned to the receivable for this period, so that
--     recognition at period end recognises only what was actually earned
--     (price − refunded) instead of the full price, which used to drive the
--     deferred account negative after a mid-period refund.
--  4. `ai_usage_records.context`: the client's own description of where a
--     turn came from ("editor", "frame", "store"). It used to be written
--     INTO `surface` verbatim, and `surface` is what decides whether a turn
--     is absorbed (free, uncapped) — a client sending `surface:
--     "scene_convert"` got free AI. `surface` is now the gate's own enum;
--     the hint lives here and nothing prices on it.
--  5. `ai_usage_records.credited_at`: stamped when the turn's charge entry
--     is reversed, so the account page and the daily cap stop counting a
--     turn the books no longer charge for (§9.2 item 11).

ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_account_id_fkey";
ALTER TABLE "subscriptions" ADD COLUMN "next_plan_code" text;

ALTER TABLE "subscription_periods"
  ADD COLUMN "refunded_micros" bigint NOT NULL DEFAULT 0 CHECK ("refunded_micros" >= 0);

ALTER TABLE "ai_usage_records" ADD COLUMN "context" text;
ALTER TABLE "ai_usage_records" ADD COLUMN "credited_at" timestamptz;

-- The rows metered before the surface/context split carry the client hint
-- where the surface belongs. All of them are scene-chat turns (the only
-- route that ever forwarded the hint), and all of them are shadow-mode
-- measurements, not journal entries, so rewriting the label is honest.
UPDATE "ai_usage_records"
   SET "context" = "surface", "surface" = 'scene_chat'
 WHERE "surface" IN ('editor', 'frame', 'store', 'store-new');
