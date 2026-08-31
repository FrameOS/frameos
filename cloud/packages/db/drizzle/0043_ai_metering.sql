-- AI metering (accounting Phase 2): one row per AI turn saying what it cost
-- us and what it would cost the customer, plus the effective-dated price
-- table and the settings those two numbers are derived from.
--
-- Still nothing charges. `ai_metering_mode` is seeded to 'shadow', which
-- means every turn is measured and priced but no ledger entry is posted;
-- Phase 3 flips it to 'live' once a week of these rows has been compared
-- against the provider's own invoice and PostHog's $ai_generation sums.
-- Design: cloud/docs/accounting-todo.md §3.2, §7 Phase 2.
--
-- Three shapes worth reading before the DDL:
--
--  1. Token counts here are DISJOINT, which is not what the provider
--     reports. OpenAI's `input_tokens` includes the cached ones, and
--     `output_tokens` includes reasoning. We store uncached input in
--     `input_tokens` and the cached part beside it, so the two add up to
--     what was sent and each can be multiplied by its own price without a
--     subtraction nobody remembers to do. `reasoning_tokens` stays a subset
--     of `output_tokens` and is recorded for analysis only — it is billed
--     as output, which is how the provider bills it.
--
--  2. Prices are micro-dollars per MILLION tokens, not per token. Per-token
--     was the first design and it cannot represent the cheap models: a
--     cached gpt-4o-mini token costs $0.075/1M, i.e. 0.075 micro-dollars,
--     which as a bigint is zero. Per million keeps every price on the
--     market today an exact integer, and the one rounding step happens once
--     per usage record (§1.1's rule), never per token.
--
--  3. Same rule as migration 0042: no foreign key points out of the
--     accounting module. `account_id` and `updated_by` hold an accounts
--     uuid as a plain column; `chat_id` an ai_chats uuid. A deleted account
--     must not take the measurement of what we spent on its behalf with it,
--     and these tables must stay movable to their own database as a unit.
--     `event_id` DOES reference financial_events: that one points *into*
--     the module, which is the direction the rule allows.

-- What the provider charges, effective-dated so a price change is a new row
-- rather than an edit and last month's entries stay explainable. Seeded
-- below from the eval price table (apps/auth-web/evals/compare-models.ts);
-- packages/ledger/src/pricing.ts carries the same numbers as a fallback for
-- a model that has no row yet, because a missing price must not silently
-- meter a turn at zero.
CREATE TABLE "ai_model_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "model" text NOT NULL,
  -- Micro-dollars per 1,000,000 tokens. $2 per 1M input = 2000000.
  "input_micros_per_mtok" bigint NOT NULL CHECK ("input_micros_per_mtok" >= 0),
  "cached_input_micros_per_mtok" bigint NOT NULL CHECK ("cached_input_micros_per_mtok" >= 0),
  -- Reasoning tokens bill as output; there is deliberately no third price.
  "output_micros_per_mtok" bigint NOT NULL CHECK ("output_micros_per_mtok" >= 0),
  "currency" text NOT NULL DEFAULT 'USD',
  "effective_from" timestamptz NOT NULL,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ai_model_prices_model_from_unique" ON "ai_model_prices" ("model", "effective_from");
CREATE INDEX "ai_model_prices_model_idx" ON "ai_model_prices" ("model", "effective_from" DESC);

-- The first global settings table in the repo: margin, overdraft, and
-- whether metering posts to the ledger at all. Superadmin-writable through
-- /admin/billing and audited there; every key has an env-var or code-level
-- fallback so a fresh database boots with sane numbers.
CREATE TABLE "billing_settings" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- An accounts uuid, unreferenced (see the header).
  "updated_by" uuid
);

-- One row per AI turn. This is the metering subledger: high volume, product
-- shaped, and the thing the ledger's per-turn entries are derived from. It
-- exists separately from financial_events because analytics wants every
-- turn (including the ones on the customer's own key, which are free to us
-- and cost them nothing here) while the ledger only wants the ones that
-- moved money.
CREATE TABLE "ai_usage_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid,
  "chat_id" uuid,
  -- The turn's own id, and the idempotency handle: the ledger event for
  -- this row is keyed 'turn:<turn_id>', so a re-post is a replay.
  "turn_id" uuid NOT NULL,
  "surface" text,
  "model" text NOT NULL,
  -- Whose key paid the provider: 'account' (the customer's own key — we
  -- incur nothing and charge nothing), 'shared' (the operator's key, our
  -- cost, not billed), 'platform' (our key, billed — Phase 3).
  "credential_source" text NOT NULL CHECK ("credential_source" IN ('account', 'shared', 'platform')),
  -- Disjoint (see the header): uncached input, cached input, output.
  "input_tokens" integer NOT NULL DEFAULT 0 CHECK ("input_tokens" >= 0),
  "cached_input_tokens" integer NOT NULL DEFAULT 0 CHECK ("cached_input_tokens" >= 0),
  "output_tokens" integer NOT NULL DEFAULT 0 CHECK ("output_tokens" >= 0),
  -- A subset of output_tokens, kept for analysis. Never priced separately.
  "reasoning_tokens" integer NOT NULL DEFAULT 0 CHECK ("reasoning_tokens" >= 0),
  "rounds" integer NOT NULL DEFAULT 0,
  -- What the provider charges us, at the prices in force when the turn ran.
  "cost_micros" bigint NOT NULL DEFAULT 0 CHECK ("cost_micros" >= 0),
  -- What we charge the customer: cost x (1 + margin), or 0 when the turn is
  -- not billable (their own key, the operator's free tier, shadow mode).
  "price_micros" bigint NOT NULL DEFAULT 0 CHECK ("price_micros" >= 0),
  "currency" text NOT NULL DEFAULT 'USD',
  -- The pricing snapshot: unit prices, margin, where the price came from.
  -- An entry has to stay explainable after the settings behind it change.
  "pricing" jsonb NOT NULL DEFAULT '{}',
  -- 'shadow' rows are measurement only and are never posted, whatever they
  -- priced at; 'live' rows post, and the sweep chases the ones that did
  -- not. Stamped per row rather than read from settings at sweep time, so
  -- flipping the switch cannot retroactively bill a week of shadow turns —
  -- backfilling that period stays a deliberate act (§7 Phase 4).
  "metering_mode" text NOT NULL DEFAULT 'shadow' CHECK ("metering_mode" IN ('shadow', 'live')),
  "event_id" uuid REFERENCES "financial_events"("id"),
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ai_usage_records_turn_unique" ON "ai_usage_records" ("turn_id");
CREATE INDEX "ai_usage_records_account_created_idx" ON "ai_usage_records" ("account_id", "created_at");
-- The sweep's queue: billable rows whose entries never landed.
CREATE INDEX "ai_usage_records_unposted_idx" ON "ai_usage_records" ("created_at")
  WHERE "event_id" IS NULL AND "metering_mode" = 'live';

-- The payment service provider is not chosen yet, so the account that holds
-- money sitting at it is named for the role, not the vendor. 0042 seeded it
-- as 'asset:psp:stripe'; nothing has posted to it (Phase 3 is the first
-- writer), so renaming is free now and would not be later.
UPDATE "ledger_accounts" SET "code" = 'asset:psp:main' WHERE "code" = 'asset:psp:stripe';

-- Provider prices as of 2026-08-31, USD per 1M tokens, standard tier:
-- gpt-5.5 5/0.5/30, gpt-5.6-terra 2/0.2/12, gpt-5.6-sol 4/0.4/20 (its
-- promotional price), gpt-5.6-luna 0.2/0.02/1.2, gpt-4o-mini 0.15/0.075/0.6
-- (the classifier's model). effective_from is the epoch: these are the
-- opening prices, and every turn metered before the first real price change
-- has to find a row.
INSERT INTO "ai_model_prices"
  ("model", "input_micros_per_mtok", "cached_input_micros_per_mtok", "output_micros_per_mtok", "effective_from", "note")
VALUES
  ('gpt-5.5',        5000000,  500000, 30000000, '1970-01-01T00:00:00Z', 'seeded from evals/compare-models.ts'),
  ('gpt-5.6-terra',  2000000,  200000, 12000000, '1970-01-01T00:00:00Z', 'seeded from evals/compare-models.ts'),
  ('gpt-5.6-sol',    4000000,  400000, 20000000, '1970-01-01T00:00:00Z', 'promotional price, seeded from evals/compare-models.ts'),
  ('gpt-5.6-luna',    200000,   20000,  1200000, '1970-01-01T00:00:00Z', 'seeded from evals/compare-models.ts'),
  ('gpt-4o-mini',     150000,   75000,   600000, '1970-01-01T00:00:00Z', 'store classifier / recategorize');

-- Opening settings. 30% margin over provider cost; a dollar of overdraft,
-- which is roughly two expensive turns and exists because a turn's cost is
-- unknown until it ends (§8.4); shadow metering until Phase 3 says
-- otherwise.
INSERT INTO "billing_settings" ("key", "value") VALUES
  ('ai_margin_percent', '30'),
  ('payg_overdraft_micros', '1000000'),
  ('ai_metering_mode', '"shadow"');
