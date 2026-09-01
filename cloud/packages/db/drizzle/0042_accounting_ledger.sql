-- Double-entry accounting: product-side financial events, a chart of
-- accounts, and the immutable journal every balance is derived from.
--
-- Nothing bills yet. This is the substrate the AI metering (0043) and
-- prepaid credits (0044) post into, laid down first so that the very first
-- cent we ever meter lands in a ledger that already balances. Design and
-- reasoning: cloud/docs/accounting-todo.md.
--
-- The shape, top to bottom: product code emits a `financial_events` row
-- ("40k tokens burned on turn X", "Stripe says $10 arrived"), a versioned
-- posting rule turns that fact into balanced `ledger_entries` +
-- `ledger_postings`, and `ledger_balances` caches the running sum. Product
-- code never writes postings; the kernel in packages/ledger is the only
-- writer, and it does all of the above in one transaction.
--
-- Amounts are bigint micro-dollars (1 USD = 1,000,000). At gpt-5.6-terra
-- prices a single token is 2 / 0.2 / 12 micro-dollars, so integer
-- micro-arithmetic keeps per-token costs exact with one rounding step per
-- usage record. Every money column carries a currency alongside it and the
-- balance invariant is per-currency, so a second currency is a data change
-- rather than a migration.
--
-- Two deliberate deviations from house patterns:
--
--  1. No foreign key points out of the ledger. `account_id` and
--     `owner_account_id` hold an accounts uuid, but they are plain columns:
--     no REFERENCES, so no cascade, no SET NULL, and nothing outside these
--     tables can reach in and rewrite them.
--
--     Books are books. A deleted account must not take the revenue it
--     produced with it, and it must not become anonymous either: "we paid
--     OpenAI $4.20 on behalf of somebody" is not an accounting record. The
--     tempting middle road — ON DELETE SET NULL, the way `audit_events`
--     declares it — turns out to lose exactly the rows that matter. A
--     metered turn posts two entries; the customer charge carries a
--     `liability:credits:customer:<uuid>` leg and stays attributable
--     through its account code, while the provider-cost entry touches only
--     system accounts and, with the id nulled, is attributable to nobody.
--     Margin per customer would then quietly skew for every period
--     containing a departed one. (`audit_events` in fact does the same
--     thing this does: it nulls the column but keeps the uuid in its
--     `actor` jsonb.)
--
--     Retaining a bare uuid is also what erasure can honestly promise here.
--     Everything that names the person — email, display name, credentials —
--     lives in `accounts` and cascades away; what is left is a
--     discriminator that separates one customer's history from another's,
--     which is what a financial record is for and what bookkeeping
--     retention law expects to still exist afterwards.
--
--     The second reason is structural: with no outward references these
--     tables are a self-contained module. If accounting ever moves to its
--     own database, it moves — nothing to unpick first.
--
--  2. Append-only is enforced by triggers, not just by convention. These
--     are the repo's first triggers and a ledger is what justifies them:
--     they turn "the kernel promises not to rewrite history" into "the
--     database will not let it". Because no cascade can reach these rows,
--     `financial_events` allows exactly one after-the-fact change — the
--     one-way `processed_at` stamp — and refuses everything else; entries
--     and postings allow nothing at all. `ledger_balances` is a derived
--     cache and stays freely writable.

-- Immutable product-side facts. One row per thing-that-happened.
CREATE TABLE "financial_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_type" text NOT NULL,
  -- An accounts uuid, deliberately unreferenced (see the header). NULL means
  -- the event belongs to no customer — a provider invoice, an opening
  -- balance — never "we forgot whose it was".
  "account_id" uuid,
  "source" text NOT NULL,
  "source_ref" text,
  "idempotency_key" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "financial_events_idempotency_unique" ON "financial_events" ("idempotency_key");
CREATE INDEX "financial_events_account_occurred_idx" ON "financial_events" ("account_id", "occurred_at");
CREATE INDEX "financial_events_pending_idx" ON "financial_events" ("created_at") WHERE "processed_at" IS NULL;

-- Reporting hierarchy. Mutable and free of accounting meaning: re-pointing
-- an account at another group re-buckets every report and touches no
-- posting. Moving an *amount* between accounts is a reclassification entry
-- instead, never an edit here.
CREATE TABLE "ledger_account_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "parent_id" uuid REFERENCES "ledger_account_groups"("id"),
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ledger_account_groups_code_unique" ON "ledger_account_groups" ("code");

-- The chart of accounts. System accounts are seeded below with
-- owner_account_id NULL; per-customer subaccounts
-- (`liability:credits:customer:<uuid>`) are created lazily on first touch.
-- `code` is the stable programmatic handle — code, never id, is what the
-- posting rules name.
CREATE TABLE "ledger_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL,
  "type" text NOT NULL CHECK ("type" IN ('asset', 'liability', 'equity', 'revenue', 'contra_revenue', 'expense')),
  "normal_side" text NOT NULL CHECK ("normal_side" IN ('debit', 'credit')),
  "currency" text NOT NULL DEFAULT 'USD',
  -- The customer a subaccount belongs to; NULL on system accounts. Same
  -- unreferenced accounts uuid as financial_events.account_id, and also
  -- spelled out inside `code`.
  "owner_account_id" uuid,
  "group_id" uuid REFERENCES "ledger_account_groups"("id"),
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ledger_accounts_code_unique" ON "ledger_accounts" ("code");
CREATE INDEX "ledger_accounts_owner_idx" ON "ledger_accounts" ("owner_account_id");

-- Journal entry header. One event may produce several entries: a metered AI
-- turn posts the customer charge and our provider cost as two independent
-- balanced entries from one fact.
CREATE TABLE "ledger_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id" uuid NOT NULL REFERENCES "financial_events"("id"),
  "entry_type" text NOT NULL,
  "rule_version" integer NOT NULL,
  "description" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "posted_at" timestamptz NOT NULL DEFAULT now(),
  "reverses_entry_id" uuid REFERENCES "ledger_entries"("id"),
  "external_ref" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX "ledger_entries_event_idx" ON "ledger_entries" ("event_id");
CREATE INDEX "ledger_entries_occurred_idx" ON "ledger_entries" ("occurred_at");
CREATE INDEX "ledger_entries_external_ref_idx" ON "ledger_entries" ("external_ref") WHERE "external_ref" IS NOT NULL;
CREATE UNIQUE INDEX "ledger_entries_reverses_unique" ON "ledger_entries" ("reverses_entry_id") WHERE "reverses_entry_id" IS NOT NULL;

-- Entry lines. Balanced per entry per currency: SUM(debits) = SUM(credits).
-- Amounts are always positive; the direction carries the sign.
CREATE TABLE "ledger_postings" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "entry_id" uuid NOT NULL REFERENCES "ledger_entries"("id"),
  "ledger_account_id" uuid NOT NULL REFERENCES "ledger_accounts"("id"),
  "direction" text NOT NULL CHECK ("direction" IN ('debit', 'credit')),
  "amount_micros" bigint NOT NULL CHECK ("amount_micros" > 0),
  "currency" text NOT NULL DEFAULT 'USD'
);
CREATE INDEX "ledger_postings_entry_idx" ON "ledger_postings" ("entry_id");
CREATE INDEX "ledger_postings_account_idx" ON "ledger_postings" ("ledger_account_id");

-- Derived cache, signed so that positive means "on this account's normal
-- side". Provably equal to the sum over postings; the nightly integrity
-- check proves it, and if it ever disagrees the postings win.
CREATE TABLE "ledger_balances" (
  "ledger_account_id" uuid PRIMARY KEY REFERENCES "ledger_accounts"("id"),
  "balance_micros" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION "ledger_rows_are_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: the ledger is append-only, correct it with a reversing entry', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "ledger_entries_immutable"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_rows_are_immutable"();

CREATE TRIGGER "ledger_postings_immutable"
  BEFORE UPDATE OR DELETE ON "ledger_postings"
  FOR EACH ROW EXECUTE FUNCTION "ledger_rows_are_immutable"();

-- Events are facts and never change either, with the single exception the
-- header explains: processed_at, stamped once by the kernel after the
-- postings land. Everything else about the row — account_id included, since
-- no cascade can reach it any more — is fixed at insert.
CREATE FUNCTION "financial_events_are_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on financial_events is not allowed: financial events are append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."processed_at" IS DISTINCT FROM OLD."processed_at" AND OLD."processed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'financial_events.processed_at is stamped once and never changed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (NEW."id", NEW."event_type", NEW."account_id", NEW."source", NEW."source_ref", NEW."idempotency_key", NEW."occurred_at", NEW."payload", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."event_type", OLD."account_id", OLD."source", OLD."source_ref", OLD."idempotency_key", OLD."occurred_at", OLD."payload", OLD."created_at") THEN
    RAISE EXCEPTION 'financial_events rows are immutable apart from the processed_at stamp'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "financial_events_append_only"
  BEFORE UPDATE OR DELETE ON "financial_events"
  FOR EACH ROW EXECUTE FUNCTION "financial_events_are_append_only"();

-- Reporting groups. Six top-level buckets is the whole hierarchy for now;
-- the parent_id column is there for the day one of them needs splitting,
-- and re-mapping an account between them costs nothing.
INSERT INTO "ledger_account_groups" ("code", "name", "sort_order") VALUES
  ('assets', 'Assets', 10),
  ('liabilities', 'Liabilities', 20),
  ('equity', 'Equity', 30),
  ('revenue', 'Revenue', 40),
  ('cost_of_revenue', 'Cost of revenue', 50),
  ('operating_expenses', 'Operating expenses', 60);

-- System accounts. Per-customer subaccounts are not seeded: they are
-- created on first touch by ensureLedgerAccount() in packages/ledger.
INSERT INTO "ledger_accounts" ("code", "type", "normal_side", "group_id")
SELECT v."code", v."type", v."normal_side", g."id"
FROM (VALUES
  ('asset:psp:stripe',              'asset',          'debit',  'assets'),
  ('asset:bank:main',               'asset',          'debit',  'assets'),
  ('liability:deferred:subscriptions', 'liability',   'credit', 'liabilities'),
  ('liability:refunds_payable',     'liability',      'credit', 'liabilities'),
  ('liability:accrued:openai',      'liability',      'credit', 'liabilities'),
  ('revenue:ai_usage',              'revenue',        'credit', 'revenue'),
  ('revenue:subscriptions',         'revenue',        'credit', 'revenue'),
  ('contra_revenue:promo',          'contra_revenue', 'debit',  'revenue'),
  ('expense:cogs:openai',           'expense',        'debit',  'cost_of_revenue'),
  ('expense:psp_fees',              'expense',        'debit',  'cost_of_revenue')
) AS v("code", "type", "normal_side", "group_code")
JOIN "ledger_account_groups" g ON g."code" = v."group_code";
