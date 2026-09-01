-- Phase 5 of cloud/docs/accounting-todo.md: plans and subscriptions (§0.1).
--
-- What varies down the ladder is the MARGIN on metered AI, not access to a
-- feature: a plan is a better rate on something everybody may already use.
-- That is why there is no "has_ai" column anywhere below, and why PAYG is a
-- real row at $0 rather than the absence of a row — "what plan is this
-- account on" then always has an answer and the margin lookup has no special
-- case to get wrong.

CREATE TABLE "billing_plans" (
  "code" text PRIMARY KEY,
  "name" text NOT NULL,
  "description" text,
  "price_micros" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "period" text NOT NULL DEFAULT 'month' CHECK ("period" IN ('month', 'year')),
  -- The plan's markup over provider cost, in basis points. Overrides the
  -- global `ai_margin_percent` setting for accounts on this plan, and is
  -- snapshotted per usage record exactly as the global one always was, so an
  -- entry stays explainable after the account changes plan.
  "margin_basis_points" integer NOT NULL CHECK ("margin_basis_points" >= 0),
  -- Quota entitlements: cloud_rendered_frames, backup_bytes, frame_log_bytes,
  -- private_scene_bytes, frames. Read by src/lib/usage.ts, never by the
  -- ledger — a plan's entitlements are not accounting facts (§3.6).
  "entitlements" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sort_order" integer NOT NULL DEFAULT 0,
  "public" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- One subscription row per account. An account with no row is on PAYG, which
-- is the same thing as a row pointing at the payg plan — the fallback exists
-- so that enrolling every existing account is not a prerequisite for shipping.
CREATE TABLE "subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "plan_code" text NOT NULL REFERENCES "billing_plans"("code"),
  "status" text NOT NULL DEFAULT 'active'
    CHECK ("status" IN ('active', 'canceling', 'canceled')),
  "started_at" timestamptz NOT NULL DEFAULT now(),
  -- Set when the user cancels: the plan runs to the end of the paid period
  -- and stops. Nothing is refunded by default (§3.6 has the recipe if we
  -- ever offer it).
  "cancel_at" timestamptz,
  "canceled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "subscriptions_account_unique" ON "subscriptions" ("account_id");

-- One row per billed period. The charge posts at period start (accruing on
-- the receivable, §3.6) and recognition posts at period end; both are
-- idempotent on this row's id, so the nightly job may run twice a night or
-- not at all for a day without double-charging or losing a period.
CREATE TABLE "subscription_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscription_id" uuid NOT NULL REFERENCES "subscriptions"("id") ON DELETE CASCADE,
  -- Snapshotted, not joined: a period is billed at the price and margin that
  -- were in force when it started, whatever the plan row says later.
  "plan_code" text NOT NULL,
  "price_micros" bigint NOT NULL,
  "margin_basis_points" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "charged_at" timestamptz,
  "recognized_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_periods_bounds" CHECK ("period_end" > "period_start")
);
CREATE UNIQUE INDEX "subscription_periods_unique"
  ON "subscription_periods" ("subscription_id", "period_start");
-- The nightly job's two queues: periods to charge and periods to recognize.
CREATE INDEX "subscription_periods_uncharged_idx"
  ON "subscription_periods" ("period_start") WHERE "charged_at" IS NULL;
CREATE INDEX "subscription_periods_unrecognized_idx"
  ON "subscription_periods" ("period_end") WHERE "recognized_at" IS NULL;

-- §0.1's ladder. Numbers are a sketch and §8.13 says what would settle them:
-- the three margins are decided, everything else is a proposal that a month
-- of live metering should confirm or move.
--
-- Storage entitlements are grounded rather than aspirational — at R2's
-- ~$0.015/GB-month, Studio's 10 GB of backups costs about 15 cents against
-- $6.99. Private scenes are the least meaningful axis (a real scene is ~9 KB,
-- so the free 100 MB is already ten thousand of them) and are here for
-- symmetry, not because anyone will meet the limit.
--
-- `frames` (your own hardware) does NOT vary: a Pi you own costs us a
-- WebSocket and a row. `cloud_rendered_frames` is the entitlement with a real
-- marginal cost (§0.2) and is the reason the free plan gets zero of them.
INSERT INTO "billing_plans"
  ("code", "name", "description", "price_micros", "period", "margin_basis_points", "sort_order", "entitlements")
VALUES
  ('payg', 'Pay as you go', 'AI when you want it, billed monthly for exactly what you used.',
   0, 'month', 10000, 0,
   '{"cloud_rendered_frames": 0, "backup_bytes": 104857600, "frame_log_bytes": 104857600, "private_scene_bytes": 104857600, "frames": 50}'::jsonb),
  ('maker', 'Maker', 'Half-price AI, five frames we render for you, and room to back things up.',
   1990000, 'month', 5000, 1,
   '{"cloud_rendered_frames": 5, "backup_bytes": 2147483648, "frame_log_bytes": 524288000, "private_scene_bytes": 1073741824, "frames": 50}'::jsonb),
  ('studio', 'Studio', 'The cheapest AI rate, twenty-five cloud-rendered frames, and serious backup space.',
   6990000, 'month', 2000, 2,
   '{"cloud_rendered_frames": 25, "backup_bytes": 10737418240, "frame_log_bytes": 2147483648, "private_scene_bytes": 5368709120, "frames": 50}'::jsonb);
