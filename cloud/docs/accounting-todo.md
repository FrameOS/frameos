# FrameOS Cloud accounting module — design + todo

Status: written 2026-08-31, **direction revised 2026-09-01** (§0). Phases 0,
1, 2, 3a, 4 and 5 are built: the ledger, the AI metering that feeds it, the
admin/ops surfaces that make it readable, the account's own view of its
usage with the switch that turns AI off, the daily cap, and plans with their
subscription lifecycle. **Phase 3b — the payment provider — is the only
thing left**, and it is what everything else is waiting on. §9 is the
review of 2026-09-01 — one billing bypass, three accounting bugs and a plan
ladder that did not do what §0.1 says — and §9.5 is what the fix
(2026-09-02, migration 0046) did about each. Metering runs in
**shadow mode**: every turn is measured and priced, and no entry is posted.
Nothing charges anybody, and self-serve plan purchase is gated off
(`FRAMEOS_CLOUD_PLANS_SELF_SERVE`) for the same reason — subscribing accrues
a receivable, and until 3b there is no way to settle one.

The goal: real double-entry accounting inside FrameOS Cloud. We meter each
account's AI spend (gpt-5.6-terra today), add a configurable margin (~30%),
and every cent is traceable through an immutable ledger.

## 0. What we are selling (decided 2026-09-01)

(Document section zero, not implementation "Phase 0" — §7 owns the phases.)

Narrower than this document's first draft, and the narrowing is the point —
every item below removes a legal or product problem rather than a technical
one, and none of them costs the ledger anything, because the accounts they
need were all seeded in Phase 0.

- **Postpay, not prepaid.** Nobody buys credits up front. Usage accrues as a
  receivable and we bill the month at the end of it. Holding other people's
  money before delivering anything is stored value — a different legal
  animal in most jurisdictions, tangled up with VAT-at-issue, expiry rules
  and unclaimed-property law — and it is not an animal worth adopting to
  sell $6 of tokens. Postpay has none of it: we invoice for a service
  already rendered, which is the most ordinary transaction there is. It also
  deletes three open decisions outright (credit expiry, the prepaid refund
  path, and what a "credit" is worth).
  *Precisely:* "already rendered" is true of **metered usage**. A
  **subscription is billed in advance** — the period is charged the day it
  starts — which is ordinary SaaS and not stored value (the customer is
  buying a defined month of service, not a balance to spend later), and the
  ledger treats it as such: deferred on the day it is charged, recognised as
  it is served (§3.6). The invoice copy has to say both things: the plan fee
  for the coming period, the AI usage for the past month. `/account/ai` says
  so already.
- **Subscriptions after postpay, not instead of it.** Not in the first
  shippable thing — metering, a cap, a visible number and an invoice have to
  work before a plan can promise anything — but they are the destination,
  and §0.1 sketches the ladder. The order matters: a plan is a *discount on
  metered usage plus some entitlements*, so the metering has to be
  trustworthy first. Building plans on top of metering nobody has checked
  against a real invoice would be selling a discount on a number we are not
  yet sure of.
- **Daily caps instead of a prepaid balance.** Postpay's one real cost is
  credit risk, and the cap is how it is bounded: **$10/day per account** to
  start, watched by hand while the numbers are small. A prepaid balance is
  the same protection collected in advance; a cap is that protection without
  taking anybody's money first.
- **Users can switch AI off entirely** (§5.1) and incur nothing. Explicit,
  per-account, off by nobody's default but reachable in one click. It
  answers "how do I make sure this never costs me anything" without asking
  anyone to trust a cap they cannot see.
- **Pricing and plans get decided later.** Provider cost plus a margin is
  the *mechanism*; what the margin is, whether there is a free monthly
  allowance, and what a plan looks like are product questions this document
  deliberately does not answer. What it does insist on is that whatever gets
  decided is expressible as a number in `billing_settings` and a recipe, not
  as a new model.

The first shippable product is therefore **metered pay-as-you-go AI, billed
monthly in arrears**: an account without its own OpenAI key runs on the
platform key, sees what it has spent on its account page (§5.2), is stopped
by the daily cap long before a surprise gets large, and receives one invoice
a month.

### 0.1 The plan ladder (sketch, 2026-09-01 — numbers not final)

Three plans, and the thing that varies down the ladder is **the margin on
metered AI**. That is an unusual axis and a good one: it means a plan is
never a wall between somebody and a feature, only a better rate on something
they were already free to use. Nothing is gated; the meter just runs slower.

| | **Pay as you go** — $0 | **Maker** — $1.99/mo | **Studio** — $6.99/mo |
|---|---|---|---|
| AI margin over provider cost | 100% | 50% | 20% |
| Daily AI cap (§5.3) | $10 | $10 | $10 |
| Cloud-rendered frames (§0.2) | 0 | 5 | 25 |
| Backups | 100 MB | 2 GB | 10 GB |
| Frame logs | 100 MB | 500 MB | 2 GB |
| Private scenes | 100 MB | 1 GB | 5 GB |
| Cloud-managed frames (your own hardware) | 50 | 50 | 50 |

Where the numbers come from, so the next person can move them on purpose:

- **The margins are the user's numbers** (100 / 50 / 20), and since
  2026-09-02 the PAYG row's 100% is what an account with no subscription
  actually pays — one number, read from the plan row by the meter and the
  page alike (§9.2 item 5; the global `ai_margin_percent` is now only the
  fallback for a deployment with no plan rows). They are also the whole
  ladder: at provider cost *c* per month, PAYG bills `2c`, Maker
  `1.99 + 1.5c`, Studio `6.99 + 1.2c`. So **Maker pays for itself at about
  $4/month of provider cost** (≈ $8 of PAYG spend, ≈ 9 turns at today's
  ~$0.44/turn) and **Studio overtakes Maker at about $16.70** (≈ 38 turns).
  Both crossovers are reachable by a real user in a real month, which is the
  test of whether a ladder is a ladder or a decoration — a tier nobody can
  climb into is just a more expensive way to buy the tier below.
- **The cap does not move between plans**, and that is deliberate. It is a
  credit-risk bound (§5.3), not a feature. Note the side effect, which is
  the right way round: the cap is a *price* limit, so a PAYG user at 100%
  margin gets ~11 turns/day out of $10 while a Studio user at 20% gets ~19.
- **Storage numbers are grounded, not aspirational.** At R2's ~$0.015/GB-mo,
  Studio's 10 GB of backups costs us about 15¢ against $6.99. The binding
  reality is abuse, not cost. Private scenes are the *least* meaningful axis
  here and the table says so honestly: a real scene is ~9 KB, so the free
  100 MB is already ten thousand scenes and raising it is theater — it is in
  the table for symmetry, and if a plan needs a fourth differentiator this
  is not it.
- **Cloud-rendered frames are the one entitlement with a real marginal
  cost**, which is why the free plan gets zero of them. §0.2.

Open, and flagged rather than guessed: whether there is a yearly price,
whether a plan changes the daily cap for accounts that ask, whether unused
entitlements roll over (they should not), and what happens to an account
that downgrades below what it is currently using (proposal: nothing breaks,
nothing new can be added, and the overage is billed at the PAYG rate).

### 0.2 Cloud-rendered frames — the entitlement that answers an old question

`docs/todo.md` has carried this for a while: *"Thin-client frames on the
cloud (ESP32-C3, embedded Pi/Pico): serving them means the cloud renders
every frame for them — free cloud rendering forever, for everyone. Decide
before building; until then C3 boards stay out of the cloud flasher."*

The plan ladder is the decision. Cloud rendering is not free and not
forever; it is an entitlement of a paid plan, and the free tier gets none.
That unblocks the C3 in the cloud flasher, which is the actual product being
held up.

Two things have to be true for the entitlement to survive contact with
arithmetic:

- **The cost driver is renders per day, not frames.** A frame refreshing
  every 5 minutes is 12× the cost of one refreshing hourly. So the plan is
  enforced as *N frames **and** a minimum refresh interval* (proposal: 5
  minutes), even though it is *displayed* as "N frames" — displaying the
  interval as a headline number would be selling people a unit they do not
  think in. At ~1 CPU-second per render, Studio's 25 frames at the 5-minute
  floor is ~2 CPU-hours/day per account: fine for tens of accounts on one
  box, and a capacity plan for hundreds.
- **It needs per-frame attribution**, which the ledger does not have —
  §8.9, unchanged and now with a date on it. When cloud rendering is
  metered rather than merely entitled, the frame uuid rides on the event
  unreferenced and the frame name is snapshotted, for the reason §8.9
  gives. Until then the entitlement is a *count check* at frame creation and
  costs the ledger nothing.

Not designed here: whether a cloud-rendered frame counts against the
50-frame cloud-managed limit (proposal: it is a separate pool, because the
two have entirely different cost profiles — your own Pi costs us a WebSocket
and a row).

Direction comes from Airbnb's "Tracking the money" post
(medium.com/airbnb-engineering/tracking-the-money-scaling-financial-reporting-at-airbnb-6d742b80f040).
We keep their principles and drop their scale machinery:

- **Decouple product logic from accounting logic.** Product code emits
  *financial events*; a separate, pure layer of *posting rules* turns events
  into balanced journal entries. Product code never writes postings directly.
- **Immutability.** Events and ledger rows are append-only. Corrections are
  reversing entries, never updates. Alterations follow Airbnb's
  unbook/rebook pattern: reverse the whole original entry, post a fresh one.
- **One subledger as the single source of truth.** Every report (balance,
  revenue, COGS, deferred revenue) is a query over the same postings, so a
  mismatch is debuggable in one place.
- **Invariant ("smoke") tests as a first-class deliverable.** The equation
  must hold at all times and a nightly job proves it.

What we do *not* need from Airbnb: Spark, HDFS, a nightly batch pipeline. At
FrameOS volume the ledger is transactional Postgres, posted synchronously in
the same transaction as the triggering write. Because immutable events are
the source of truth, a batch/derived reporting layer can be added later
without re-architecting.

---

## 1. Core model

Three layers, top to bottom:

```
product code (chat route, PSP webhook, admin action, cron)
      │  emits, append-only
      ▼
financial_events          "what happened" — product-side facts, idempotent
      │  posting rules (pure TS functions, versioned)
      ▼
ledger_entries + ledger_postings    "what it means" — balanced double entries
      │  same-transaction upsert
      ▼
ledger_balances           derived cache, provably equal to SUM(postings)
```

### 1.1 Money representation

- All amounts are `bigint` **micro-dollars** (1 USD = 1,000,000 µ$). At
  gpt-5.6-terra prices ($2 / $0.20 / $12 per 1M input/cached/output tokens) a
  single token is 2 µ$ / 0.2 µ$ / 12 µ$ — micro precision keeps per-token
  arithmetic in integers with at most one rounding step per usage record
  (round half-up, at the record level, never per token).
- Single currency (USD) at launch. `currency` column exists everywhere from
  day one and the balance invariant is per-currency, so adding EUR later is a
  data change, not a schema change.
- There is no credit *commodity*, and since §0 no credit *balance* either: an
  account's billing state is the balance of its **receivable**, denominated
  in USD, and the UI says dollars because dollars is what it is. (If prepaid
  ever comes back, §3.5 keeps the model intact; promotional grants net
  against the receivable instead — §3.4.)

### 1.2 Chart of accounts

`ledger_accounts` holds both **system accounts** (one row each) and
**per-customer subaccounts** (created lazily, `owner_account_id` set). The
account `code` is the stable programmatic handle.

Launch chart (system accounts):

| code | type | normal side | purpose |
|---|---|---|---|
| `asset:psp:main` | asset | debit | money sitting at the payment provider (charges land here, fees and payouts leave) |
| `asset:bank:main` | asset | debit | our bank account (used once payouts/reconciliation arrive) |
| `asset:receivable:customer:<id>` | asset | debit | **what a customer owes us for metered usage — the live customer account** (§0) |
| `liability:credits:customer:<id>` | liability | credit | prepaid credit balance (shelved with §3.5; nothing posts here) |
| `liability:credits_promo:customer:<id>` | liability | credit | granted/promo credits, prepaid model only (shelved, §3.5) |
| `liability:deferred:subscriptions` | liability | credit | subscription fees collected but not yet earned |
| `liability:refunds_payable` | liability | credit | refunds approved but not yet sent |
| `liability:accrued:openai` | liability | credit | provider cost incurred, invoice not yet paid |
| `revenue:ai_usage` | revenue | credit | recognized PAYG revenue |
| `revenue:subscriptions` | revenue | credit | recognized subscription revenue |
| `contra_revenue:promo` | contra-revenue | debit | cost of granting promo credits |
| `expense:cogs:openai` | expense | debit | provider cost of metered usage |
| `expense:psp_fees` | expense | debit | payment-provider fees |
| `expense:bad_debt` | expense | debit | invoices we gave up collecting (added in Phase 3, §3.2) |

Under postpay the live customer account is `asset:receivable:customer:<id>`
— an asset, because unbilled usage is money owed *to* us. The two
`liability:credits:*` rows stay in the chart and in `chart.ts`: they cost
nothing to keep, they are already tested, and shelving a model is not the
same as deleting it. `expense:bad_debt` is the only account the postpay
switch actually adds, and `customerReceivableCode()` already exists.

The margin is **derived, never stored as a balance**: revenue posts at
customer price, COGS posts at provider cost, and margin = the difference.
The margin *setting* used for a given entry is snapshotted in entry metadata
(§4.3) so historical entries stay explainable after the setting changes.

### 1.3 "Moving entries between groups"

Two distinct mechanisms, and it matters which one a situation calls for:

1. **Reporting groups (mutable, zero accounting impact).**
   `ledger_account_groups` is a small hierarchy table; each ledger account
   points at a group. Reports aggregate by group. Re-mapping an account to a
   different group re-buckets every report instantly and touches no postings.
   Use for: "AI revenue should show under Platform, not Labs".
2. **Reclassification (immutable, real accounting impact).** A new journal
   entry that debits one account and credits another (e.g. moving a booked
   amount from `revenue:ai_usage` to `revenue:subscriptions` because it was
   posted wrong). The original entry is never touched; the reclass entry
   links to it via `metadata.reclassifies` and deliberately **not** through
   `reverses_entry_id` — that column means "these two entries cancel out leg
   for leg", which invariant 7 proves for every row that has it, and a
   reclassification moves one amount while leaving the rest of the original
   alone. Use for: actual mistakes or genuine changes in the nature of an
   amount.

---

## 2. Schema

New migration `packages/db/drizzle/0042_accounting_ledger.sql` + matching
`pgTable` blocks in `packages/db/src/schema.ts` (house rule: hand-written SQL,
schema.ts maintained in parallel; open with the usual why-comment block).

```sql
-- Immutable product-side facts. One row per thing-that-happened.
CREATE TABLE "financial_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_type" text NOT NULL,          -- 'credit_purchase.succeeded', 'ai_usage.turn', ...
  "account_id" uuid,                   -- accounts uuid, NO foreign key (§2.1); NULL only for system-level events
  "source" text NOT NULL,              -- 'metering' | 'psp_webhook' | 'admin' | 'cron' | 'backfill'
  "source_ref" text,                   -- turn id, provider event id, ...
  "idempotency_key" text NOT NULL,     -- the dedupe handle, e.g. 'psp:evt_...' or 'turn:<uuid>'
  "occurred_at" timestamptz NOT NULL,  -- economic time (when the tokens were burned)
  "payload" jsonb NOT NULL,            -- full fact: token counts, provider object, ...
  "processed_at" timestamptz,          -- set when posting rules ran; NULL = pending/failed
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "financial_events_idempotency_unique" ON "financial_events" ("idempotency_key");
CREATE INDEX "financial_events_account_occurred_idx" ON "financial_events" ("account_id", "occurred_at");
CREATE INDEX "financial_events_pending_idx" ON "financial_events" ("created_at") WHERE "processed_at" IS NULL;

-- Reporting hierarchy; mutable, no accounting meaning.
CREATE TABLE "ledger_account_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL,                -- stable handle, like ledger_accounts.code
  "name" text NOT NULL,
  "parent_id" uuid REFERENCES "ledger_account_groups"("id"),
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ledger_account_groups_code_unique" ON "ledger_account_groups" ("code");

-- Chart of accounts. System rows have owner_account_id NULL.
CREATE TABLE "ledger_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL,                -- 'liability:credits:customer:<uuid>' etc.
  "type" text NOT NULL,                -- 'asset'|'liability'|'equity'|'revenue'|'contra_revenue'|'expense'
  "normal_side" text NOT NULL,         -- 'debit'|'credit'
  "currency" text NOT NULL DEFAULT 'USD',
  "owner_account_id" uuid,             -- accounts uuid, no foreign key (§2.1)
  "group_id" uuid REFERENCES "ledger_account_groups"("id"),
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ledger_accounts_code_unique" ON "ledger_accounts" ("code");
CREATE INDEX "ledger_accounts_owner_idx" ON "ledger_accounts" ("owner_account_id");

-- Journal entry header. One event may produce several entries.
CREATE TABLE "ledger_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id" uuid NOT NULL REFERENCES "financial_events"("id"),
  "entry_type" text NOT NULL,          -- posting-rule name, e.g. 'ai_usage_charge'
  "rule_version" integer NOT NULL,     -- version of the posting rule that built it
  "description" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,  -- economic date (drives revenue period)
  "posted_at" timestamptz NOT NULL DEFAULT now(),
  "reverses_entry_id" uuid REFERENCES "ledger_entries"("id"),
  "external_ref" text,                 -- provider charge/fee/payout id — reconciliation hook
  "metadata" jsonb NOT NULL DEFAULT '{}'  -- pricing snapshot: token counts, unit prices, margin
);
CREATE INDEX "ledger_entries_event_idx" ON "ledger_entries" ("event_id");
CREATE INDEX "ledger_entries_occurred_idx" ON "ledger_entries" ("occurred_at");
CREATE INDEX "ledger_entries_external_ref_idx" ON "ledger_entries" ("external_ref") WHERE "external_ref" IS NOT NULL;
-- An entry is reversed once. The rule checks it too, for a better message.
CREATE UNIQUE INDEX "ledger_entries_reverses_unique" ON "ledger_entries" ("reverses_entry_id") WHERE "reverses_entry_id" IS NOT NULL;

-- Entry lines. Balanced per entry per currency: SUM(debits) = SUM(credits).
CREATE TABLE "ledger_postings" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "entry_id" uuid NOT NULL REFERENCES "ledger_entries"("id"),
  "ledger_account_id" uuid NOT NULL REFERENCES "ledger_accounts"("id"),
  "direction" text NOT NULL,           -- 'debit'|'credit'
  "amount_micros" bigint NOT NULL CHECK ("amount_micros" > 0),
  "currency" text NOT NULL DEFAULT 'USD'
);
CREATE INDEX "ledger_postings_entry_idx" ON "ledger_postings" ("entry_id");
CREATE INDEX "ledger_postings_account_idx" ON "ledger_postings" ("ledger_account_id");

-- Derived cache; invariant: equals SUM over postings. Signed: positive = normal side.
CREATE TABLE "ledger_balances" (
  "ledger_account_id" uuid PRIMARY KEY REFERENCES "ledger_accounts"("id"),
  "balance_micros" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
```

Plus product-side tables introduced by their phases:

```sql
-- Migration 0043: the metering subledger (one row per AI turn), the
-- effective-dated provider price table, and the first global settings table.
--
-- Two things in here differ from the first sketch of them, both learned
-- while writing the pricing code:
--
--  * Token counts are DISJOINT. The provider's `input_tokens` includes the
--    cached ones and its `output_tokens` includes reasoning; we store
--    uncached input separately from cached, so each multiplies by its own
--    price without a subtraction anyone can forget. `reasoning_tokens`
--    stays a subset of `output_tokens`, recorded for analysis and billed as
--    output (§8.2 still wants that confirmed against a real invoice).
--  * Prices are per MILLION tokens, not per token. Per-token cannot
--    represent the cheap models at all: a cached gpt-4o-mini token is
--    $0.000000075, i.e. 0.075 micro-dollars, which as a bigint is zero.
CREATE TABLE "ai_usage_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid,                   -- accounts uuid, no foreign key (§2.1)
  "chat_id" uuid,
  "turn_id" uuid NOT NULL,             -- the idempotency handle: 'turn:<id>'
  "surface" text,                      -- 'scene_chat' | 'app_chat' | 'scene_convert' | 'store_classify' | ...
  "model" text NOT NULL,
  "credential_source" text NOT NULL,   -- 'account' | 'shared' | 'platform'
  "input_tokens" integer NOT NULL,     -- UNCACHED input
  "cached_input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "reasoning_tokens" integer NOT NULL, -- a subset of output_tokens
  "rounds" integer NOT NULL,
  "cost_micros" bigint NOT NULL,       -- provider cost at snapshot prices
  "price_micros" bigint NOT NULL,      -- customer price = cost x (1 + margin), 0 when not billable
  "currency" text NOT NULL DEFAULT 'USD',
  "pricing" jsonb NOT NULL,            -- {unit prices, margin, where the price came from}
  "metering_mode" text NOT NULL,       -- 'shadow' | 'live', stamped per row
  "event_id" uuid REFERENCES "financial_events"("id"),  -- NULL until posted
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ai_usage_records_turn_unique" ON "ai_usage_records" ("turn_id");
CREATE INDEX "ai_usage_records_account_created_idx" ON "ai_usage_records" ("account_id", "created_at");
CREATE INDEX "ai_usage_records_unposted_idx" ON "ai_usage_records" ("created_at")
  WHERE "event_id" IS NULL AND "metering_mode" = 'live';

CREATE TABLE "ai_model_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "model" text NOT NULL,
  "input_micros_per_mtok" bigint NOT NULL,        -- $2 per 1M = 2000000
  "cached_input_micros_per_mtok" bigint NOT NULL,
  "output_micros_per_mtok" bigint NOT NULL,       -- reasoning tokens bill as output
  "currency" text NOT NULL DEFAULT 'USD',
  "effective_from" timestamptz NOT NULL,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ai_model_prices_model_from_unique" ON "ai_model_prices" ("model", "effective_from");

CREATE TABLE "billing_settings" (
  "key" text PRIMARY KEY,              -- 'ai_margin_percent' | 'payg_overdraft_micros' | 'payg_daily_cap_micros' | 'ai_metering_mode'
  "value" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid                    -- accounts uuid, no foreign key (§2.1)
);

-- Phase 3b (migration 0046 — 0045 went to plans): one invoice per account per
-- month (§3.2). Deliberately holds no
-- amount the ledger does not: the receivable IS the balance owed, and a
-- second copy of it here is a second thing to be wrong. What the row exists
-- for is the things the ledger has no opinion about — where the period was
-- cut, which sequential number the invoice carries, whether it was paid, and
-- which provider payment settled it. Provider-neutral (§8.7).
CREATE TABLE "invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,          -- accounts uuid, no foreign key (§2.1)
  "number" text NOT NULL,              -- human/legal sequential number
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,   -- half-open; the receivable as of here
  "currency" text NOT NULL DEFAULT 'USD',
  "status" text NOT NULL,              -- 'open'|'paid'|'uncollectible'|'void'
  "provider" text,                     -- 'stripe' | 'paddle' | ...
  "provider_payment_id" text,          -- what reconciliation matches on
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "invoices_number_unique" ON "invoices" ("number");
CREATE UNIQUE INDEX "invoices_period_unique" ON "invoices" ("account_id", "period_start");

-- Shelved (§0): prepaid purchase intents and subscriptions. Sketched here
-- because §3.5/§3.6 keep the recipes and a schema sketch is cheaper to keep
-- than to re-derive, NOT because anything is scheduled to build them.
CREATE TABLE "credit_purchases" ( ... );       -- account_id, amount_micros, status, provider, provider_checkout_id, provider_payment_id
CREATE TABLE "billing_plans" ( ... );          -- code, name, price_micros, period ('month'), features jsonb, active
CREATE TABLE "subscriptions" ( ... );          -- account_id, plan, status, started_at, cancel_at, payment method
CREATE TABLE "subscription_periods" ( ... );   -- subscription_id, period_start/end, charged entry, recognition state
```

The one column postpay adds outside the ledger lives on an existing table:
`accounts.ai_disabled_at` (§5.1), the explicit AI opt-out.

### 2.1 Deliberate deviations from house patterns

- **No foreign key points out of the ledger** (decided 2026-08-31, revised
  the same day — see below). `account_id` / `owner_account_id` hold an
  accounts uuid as a plain column: no `REFERENCES`, so no cascade, no
  `SET NULL`, nothing outside these tables able to rewrite them. House style
  cascades account-owned rows, but books are books: the accounting equation
  cannot depend on nobody exercising erasure, and `POST /api/account/delete`
  is a single `DELETE FROM accounts` leaning on cascades, so `RESTRICT`
  would break self-serve deletion outright.

  *Revised from `ON DELETE SET NULL`*, which was the first decision and is
  wrong in a way worth recording. It loses precisely the rows that matter: a
  metered turn posts two entries, and while the customer charge carries an
  `asset:receivable:customer:<uuid>` leg that keeps it attributable through
  its account code, the provider-cost entry
  (`Dr expense:cogs:openai / Cr liability:accrued:openai`) touches only
  system accounts — with the id nulled it is attributable to nobody, and
  per-customer margin silently skews for any period containing a departed
  customer. The `audit_events` precedent it claimed does not say what it
  seemed to either: that table nulls its column but keeps the account uuid
  in its `actor` jsonb, i.e. it already does what this now does.

  Retaining a bare uuid is also what erasure can honestly promise. Every
  field that names the person — email, display name, credentials — lives in
  `accounts` and cascades away; what remains is a discriminator that
  separates one customer's history from another's, which is what a financial
  record is *for*, and what bookkeeping-retention law expects to still exist
  (GDPR art. 17(3)(b) covers retention required by law — the privacy policy
  needs a billing-records line before we take money; §8.8).

  Second reason, and the one that generalizes: with no outward references
  these tables are a self-contained module. **If accounting moves to its own
  Postgres database, it moves** — nothing to unpick first. Any new financial
  table follows the same rule, including the Phase 2/3 ones above.
- **Append-only enforced in the database, not just in code.** The repo had
  no triggers; a ledger justifies the first ones — `BEFORE UPDATE OR DELETE`
  on `financial_events`, `ledger_entries`, `ledger_postings` raising an
  exception. Cheap, and it turns "we promise" into "it cannot happen".
  Because no cascade can reach these rows, `financial_events` allows exactly
  one after-the-fact change and refuses every other: the one-way
  `processed_at` stamp the kernel writes. (Under the old `SET NULL` design
  the trigger also had to permit `account_id` going to NULL, or account
  deletion would have failed on the ledger — dropping the foreign key
  removed that hole rather than widening it.)
- **Balanced-entry enforcement**: primary enforcement is the posting kernel
  (§4.1) which is the *only* code path that writes entries and refuses
  unbalanced input inside the transaction. Optionally add a deferred
  `CONSTRAINT TRIGGER` re-checking SUM(debits)=SUM(credits) per entry at
  commit. Start with kernel + nightly checker; add the constraint trigger if
  we ever grow a second writer.

---

## 3. Entry recipes (posting rules)

Each recipe is a pure, versioned TypeScript function
`(event) => LedgerEntryDraft[]` living in a new Next-free package (§4). All
examples at terra prices with a 30% margin.

The launch model is **postpay** (§0): usage accrues as a receivable, a daily
cap bounds it, one invoice at the end of the month collects it. Prepaid
credits (§3.5) stay modelled below without being roadmap; subscriptions
(§3.6) are roadmap, just later than postpay (§0.1, Phase 5). Both keep their
recipes here because the accounts are already in the chart and a worked
model is cheaper to keep than to re-derive.

### 3.1 AI usage — the postpay core (Phase 2/3)

A turn on the platform key burns 40k input + 12k cached + 30k output tokens:
cost = 40k×2 + 12k×0.2 + 30k×12 = 442,400 µ$ (~$0.44). Price at 30% margin
= 575,120 µ$. Two *independent* leg pairs from one event:

```
Entry 'ai_usage_charge'         (metadata: tokens, unit prices, margin=0.30)
  Dr asset:receivable:customer:<id>          0.575120
  Cr revenue:ai_usage                        0.575120

Entry 'ai_usage_cost'
  Dr expense:cogs:openai                     0.442400
  Cr liability:accrued:openai                0.442400
```

The only thing §0 changed about what `rules/ai-usage.ts` already posts is
that first leg: it debits the customer's **receivable** (an asset — what
they owe us) instead of drawing down a prepaid **liability**. That is a
`version: 2` bump on the rule, not a re-model. `customerReceivableCode()`
has been in `chart.ts` since Phase 0, the prefix is registered, and every
other leg is untouched — which is the payoff for having separated recipes
from the kernel in the first place.

Revenue is recognized immediately: for metered usage, service-rendered time
*is* usage time. Postpay puts the recognition and the receivable in the same
entry, which is the textbook accrual shape and strictly simpler than the
prepaid one it replaces — no deferred-revenue balance to carry, no unused
balance we owe back, nothing to refund when somebody stops using us.

What it costs instead is **credit risk**: an invoice can go unpaid, which a
prepayment cannot. That is precisely what the daily cap (§5.3) bounds. The
cap is a credit limit wearing a unit users understand.

The accrued OpenAI liability is settled when we actually pay their invoice
(`Dr liability:accrued:openai / Cr asset:bank:main`), and the drift between
accrual and invoice is what reconciliation will measure later.

Usage on the customer's **own** OpenAI key produces a usage record with
`price_micros = 0` and *no* charge entry (they pay OpenAI directly) and no
cost entry (we incurred nothing). We still keep the record for analytics.
An absorbed surface (§5) books the cost entry and never the charge one.

### 3.2 Monthly invoice, payment, and the unpaid case (Phase 3)

At period close the receivable **is** the invoice: the customer's balance on
`asset:receivable:customer:<id>` for the month is what they owe, leg for leg,
with every metered turn behind it already in the journal. Issuing the
invoice therefore posts **nothing** — it is a document rendered over existing
postings, which is the property double-entry was supposed to buy us. (The
`invoices` row Phase 3 adds exists to freeze the period boundary, the
sequential number and the PDF, not to hold an amount the ledger doesn't.)

Only the payment moves money:

```
Entry 'invoice_payment'         (external_ref: the provider's payment id)
  Dr asset:psp:main                          6.420000
  Cr asset:receivable:customer:<id>          6.420000

Entry 'psp_fee'                 (external_ref: the provider's fee/txn id)
  Dr expense:psp_fees                        0.440000
  Cr asset:psp:main                          0.440000
```

A failed charge or an ignored invoice posts nothing at all: the receivable
simply stays on the books and ages, which is the correct statement of the
fact and exactly what a receivables-aging report is for. Only giving up
posts:

```
Entry 'receivable_writeoff'     (metadata: invoice id, reason, who decided)
  Dr expense:bad_debt                        6.420000
  Cr asset:receivable:customer:<id>          6.420000
```

`expense:bad_debt` is the one system account postpay adds (§8.11 picks its
reporting group). A write-off is a superadmin action through the same
audited journal route Phase 4 built, never an automatic one — the same rule
as the nightly job: report, don't repair.

Two product decisions ride on this recipe and neither touches the ledger:

- **A minimum invoice threshold.** Below it (proposal: $1) the receivable
  rolls into next month untouched — charging a card for $0.11 costs more in
  fees than it collects. The balance is still owed, still visible, still
  posted; only the collection waits.
- **Dunning.** Retry schedule, when AI switches off for an unpaid balance,
  when a human is emailed. All of it reads the receivable and writes none
  of it.

Provider choice (§8.7) is now a *harder* requirement than prepaid checkout
was: postpay needs a **stored payment method chargeable later**, not a
one-off hosted checkout. That narrows the field and should be decided with
this recipe in hand.

### 3.3 Corrections and alterations

Never edit. Post `Entry X-reversal` (`reverses_entry_id = X`, every leg
mirrored) and then, if needed, a fresh correct entry. Full
reverse-and-rebook, not deltas — Airbnb's lesson: deltas compound into
unauditability.

### 3.4 Promo / granted credits

Under postpay a grant is a **credit against the receivable** — we reduce
what somebody owes rather than handing them a spendable balance:

```
Entry 'promo_grant'
  Dr contra_revenue:promo                    5.000000
  Cr asset:receivable:customer:<id>          5.000000
```

Same contra-revenue treatment as the prepaid version, one account fewer to
reconcile, and no unused-promo-balance liability to carry, expire or explain.
It is also the shape a "free monthly allowance" takes if §0's deferred
pricing question comes back with one: a monthly grant capped at the
allowance, posted by the nightly job, netting the first $N of usage to zero
while the usage itself stays fully metered and fully visible.

`liability:credits_promo:customer:<id>` stays in the chart for the prepaid
model (§3.5) and nothing posts to it today.

### 3.5 Prepaid credits — modelled, shelved (§0)

Kept because the accounts, the kernel support and the reasoning already
exist, and because "let people top up in advance" is the single most likely
thing to come back if postpay's collection rate disappoints. Not built, not
scheduled.

A checkout for $10 succeeds (the provider's "payment completed" webhook):

```
Entry 'credit_purchase'         (external_ref: the provider's payment id)
  Dr asset:psp:main                         10.000000
  Cr liability:credits:customer:<id>        10.000000
```

The fee books as in §3.2 — `Dr expense:psp_fees / Cr asset:psp:main` — and
the customer's balance is the full $10, because the fee is our cost, not
theirs. Usage then debits `liability:credits:customer:<id>` instead of the
receivable (that is rule version 1, still in the repo and still tested).

What shelving this buys, and therefore what taking it off the shelf would
cost again: credit expiry as a terms-of-service problem, VAT possibly owed
at *issue* rather than at use, unclaimed-property exposure on dormant
balances, refunds of unspent money, and a "1 credit = $0.01" fake currency
to explain. §0 judged that a poor trade for a product whose median invoice
is a few dollars.

### 3.6 Subscriptions (§0.1) — built 2026-09-01 (Phase 5), corrected 2026-09-02

Under postpay a subscription is *simpler* than the prepaid version this
section used to model, because there is no balance to charge from. At period
rollover:

```
Entry 'subscription_charge'        (occurred_at: period start)
  Dr asset:receivable:customer:<id>          1.990000
  Cr liability:deferred:subscriptions        1.990000
```

Recognition over the period — **daily, from the nightly job** (built
2026-09-02, §9.3; it used to be one entry at period end, which made a
calendar-month P&L lag by up to a month). Each night earns
`(price − refunded) × whole days served ÷ period length` less what was
already recognised, with `subscription_periods.recognized_micros` as the
cursor that makes it idempotent; the close-out at period end earns whatever
is left and stamps `recognized_at`. Whole days, so a job that runs twice in
a night posts nothing the second time. A month of Maker therefore reads as
~31 entries of $0.064:

```
Entry 'subscription_recognition'        (one per day served)
  Dr liability:deferred:subscriptions        0.064194
  Cr revenue:subscriptions                   0.064194
```

Refunds and accruals bound each other: a refund may return only what is
still deferred (`price − refunded − recognized`), and an accrual never
earns past it, so the deferred account cannot go negative whichever order
the two land in. Revenue already recognised is not handed back from the
deferral — that is a reversal, a separate act.

and the same month-end invoice (§3.2) collects the subscription and the
metered AI together, because both are already sitting on the same
receivable. That is the payoff for making postpay the base: a plan needs no
payment path of its own, no second dunning story, and no reconciliation
between two ways of owing us money.

Three consequences worth stating, because they are what keeps §0.1's ladder
from turning into a model change:

- **A plan's margin is not an accounting fact.** It changes what
  `price_micros` the metering computes — a per-plan override of
  `billing_settings.ai_margin_percent`, snapshotted into the record's
  `pricing` exactly as the global setting always was — and `rules/ai-usage`
  never learns that plans exist. Which is the test of whether §0.1 was
  designed or merely priced: if the ladder had needed a new posting rule, it
  would have been the wrong ladder.
- **A plan's entitlements are not accounting facts either.** Cloud-rendered
  frame counts and storage limits are quota checks (`src/lib/usage.ts`'s
  free-tier constants become per-plan lookups), and the ledger sees none of
  them.
- **Mid-period changes already have a home.** Because recognition is
  separate from charging, the unearned remainder of a period always sits in
  `liability:deferred:subscriptions`:

```
Entry 'subscription_refund_to_receivable'   (cancel halfway, $1.00 unearned)
  Dr liability:deferred:subscriptions        1.000000
  Cr asset:receivable:customer:<id>          1.000000
```

  It nets against what they owe rather than becoming cash we have to send —
  under postpay that is usually the entire answer, and it is one more thing
  prepaid would have handed us as a problem. An upgrade mid-period is
  reverse-and-rebook (§3.3): refund the unearned remainder of the period
  pro rata by time, close the period now, open one at the new price from
  now. A downgrade waits for the rollover (`subscriptions.next_plan_code`):
  they keep what they are paying for. Recognition at period end earns
  `price − refunded` (`subscription_periods.refunded_micros`), never the
  full price over a refund — the deferred-revenue invariant (§6 check 9)
  is what proves it. The cash-refund path
  (`Dr liability:deferred:subscriptions / Cr liability:refunds_payable`,
  then `Dr liability:refunds_payable / Cr asset:psp:main`) stays on the
  shelf for the case where somebody has already paid and is leaving.

If prepaid ever comes back (§3.5), the charge leg swaps to
`Dr liability:credits:customer:<id>` and nothing else moves.

---

## 4. Code layout

Next-free package **`cloud/packages/ledger`** (`@frameos-cloud/ledger`),
mirroring how `scene-convert` is packaged, so `frame-hub`, scripts, and tests
use it without Next. Its unit tests run under `pnpm test`; the kernel's own
tests need Postgres and run under `pnpm test:integration`, with the same
migration-replay global setup auth-web and the hub use (own database,
`frameos_cloud_ledger_test`, wired into cloud-ci):

- `src/kernel.ts` — **the posting kernel**, the only writer:
  `postEvent(db, {eventType, accountId, idempotencyKey, occurredAt, payload})`.
  In one transaction: insert `financial_events` (on idempotency conflict:
  return the existing result — safe replay), run the matching posting rule,
  validate every draft entry balances per currency, insert entries +
  postings, upsert `ledger_balances` (`... ON CONFLICT DO UPDATE SET
  balance_micros = balance_micros + delta`; row-level upsert contention is
  the lock ordering — order account ids before writing), stamp
  `processed_at`.
- `src/rules/*.ts` — one file per recipe, each exporting
  `{name, version, build(event): EntryDraft[]}`. Bump `version` on any
  logic change; old entries keep their `rule_version`.
- `src/chart.ts` — chart definitions + `ensureLedgerAccount(db, code, ...)`
  lazy creation (customer subaccounts on first touch). Codes canonicalize
  before lookup — the customer uuid is lowercased — because a leg naming the
  same customer in another casing would otherwise mint a second account and
  split their balance. Any new code shape must define its canonical form in
  `resolveAccountCode`.
- `src/pricing.ts` — price lookup (`ai_model_prices` effective-dated, with a
  hardcoded fallback seeded from `evals/compare-models.ts` values), margin
  from `billing_settings`, cost/price computation with the single-rounding
  rule. `splitProviderUsage` is the one door provider token counts come
  through: it separates cached input out of the reported total, because
  multiplying a total that secretly contains a differently-priced part is
  the bug that shows up as a percentage of revenue and never as a crash.
  A model with no price row prices at a deliberately conservative fallback
  rather than at zero, and the snapshot says which — an unknown price that
  read as free would hide the whole of its spend.
- `src/settings.ts` — the margin / daily-cap / overdraft / metering-mode
  knobs, with a
  code-level default for every key and an env-var bootstrap for the margin.
  Values are validated on write, not on read: a typo'd setting has to fail
  where a human can see it.
- `src/metering.ts` — `recordAiUsage` (write the record, then post) and
  `sweepUnpostedUsage` (the nightly catch-up). The order is the design; §4.1
  says why.
- `src/reports.ts` — trial balance, journal listing, customer statement,
  group management and the nightly summary. All of it reads the postings,
  never `ledger_balances`: a report that trusted the cache could not notice
  the cache had gone wrong.
- `src/balances.ts` — `accountBalanceMicros(db, code)` off the cache,
  `accountBalanceFromPostings` for the slow always-correct answer, and
  `availableCreditMicros(db, accountId, {overdraftMicros})`, which belongs
  to the shelved prepaid model (§3.5) and no longer has a caller ahead of
  it. Postpay's gate does not read the ledger at all: `dailySpendMicros()`
  (Phase 3a) sums `ai_usage_records` for the current UTC day, because the
  cap must also hold for shadow-mode and own-key turns, which post nothing
  — §5.3.
- `src/money.ts` — the one door micro-dollar amounts come through: jsonb
  payloads carry them as decimal strings, because JSON's single number type
  silently loses integers above 2^53.
- `src/integrity.ts` — the invariant checks (§6), callable from tests and
  the nightly script.

`apps/auth-web/src/lib/billing.ts` wraps the package for route use (session
scoping, wire payloads — snake_case JSON per house rule). Its one rule:
**a metering failure never changes what the user got.** A finished turn is
delivered whether or not the ledger could be written; the failure is
reported and the sweep picks the measurement back up.
`apps/auth-web/src/lib/billing-admin.ts` holds the one thing the ledger
deliberately does not — customer names, resolved live and degrading to the
bare uuid (§8.10).

### 4.1 Why synchronous posting (and the one exception)

Purchases, subscription charges, refunds: post in-line in the route/webhook
transaction — these are rare and must be durable before we ack.

AI usage: post from `onFinish` in the chat route (fire from the turn-runner
so detached/resumed turns still post — the turn may outlive the HTTP
request). If the ledger write fails, the usage record still exists with
`event_id NULL`; a sweep (nightly job, §7 Phase 4) re-posts unposted
records. This gives at-least-once posting with idempotency (`turn:<uuid>`)
making it exactly-once. Per-turn entries are fine at our volume; if postings
ever get heavy, switch the recipe to hourly rollup entries per account —
the metering table already supports that without schema change.

---

## 5. Product integration points (facts from the current code)

- **Payer signal** (Phase 2, done): `resolveAiCredentials()` in
  `apps/auth-web/src/lib/ai/api-key.ts` returns
  `source: "account" | "shared"`, and the chat route now threads it into the
  usage record instead of dropping it. Billing rule: `account` → record
  only, and no cost either (they paid the provider); `shared` → record plus
  a COGS entry (the operator's free tier is a real bill we absorb);
  `platform` → both. Phase 3 adds `"platform"` to what
  `resolveAiCredentials` can return; until then nothing is billable.
- **Commit point** (done): `startTurn()`'s `onFinish` in
  `apps/auth-web/src/lib/ai/turn-runner.ts`, metered fire-and-forget so the
  turn is not held open by it, and metered whatever the outcome — a turn
  that errored or was stopped still burned the tokens it burned. `turnId`,
  which was in-memory only, is now persisted as `ai_usage_records.turn_id`
  and is the idempotency handle.
- **Other OpenAI call sites** (done): app-code chat
  (`src/lib/ai/app-chat.ts`, which also now goes through
  `resolveAiCredentials` rather than reading the account key itself), scene
  convert (`app/api/scenes/convert/route.ts` — a caller's own key meters as
  `account`, the platform key as `shared`), and the store classifier at
  publish and recategorize. Moderation is not metered: OpenAI's
  omni-moderation endpoint is free, so there is nothing to book.
- **Absorbed surfaces** (done): `absorbedSurfaces` in
  `packages/ledger/src/metering.ts` names the surfaces the platform pays for
  on purpose — today just `scene_convert`. On one of our keys they book the
  provider cost as COGS and price at nothing, and unlike the `shared`/
  `account` distinction that is a property of the *surface*, so it survives
  Phase 3 handing that route a billable key. The reasoning is product, not
  accounting: we deprecated compiled scenes and asked everyone to convert, so
  the conversion is our migration cost, not a line on their bill. Anything
  else we decide to give away goes in the same list, and the books then show
  it as what it is — a cost with no revenue against it, visible in the trial
  balance rather than hidden in a route that never charges.
  Still unpriced, and deliberately: the conversion's *compute* (the headless
  render check on our own box) has no cost model anywhere in the ledger yet —
  that is the same unanswered "free cloud rendering" question §7 Phase 6
  parks, and it is infrastructure spend rather than a per-turn provider bill.
- **The three gates** a platform-key turn passes before it starts, in this
  order, because they answer three different questions: is AI on for this
  account at all (§5.1), is the account inside today's cap (§5.3), and is
  there an unpaid balance old enough to stop serving (dunning, §3.2). Each
  is a distinct refusal with a distinct message; collapsing them into one
  "you can't do that" is how a user ends up guessing.
- **Surfacing** (§5.2): `GET /api/account/usage` — already the aggregation
  point MCP `account_quota` proxies — grows an `ai` block, and the account
  header grows an "AI usage" row next to the storage meters.
- **Margin config** (done): `billing_settings` is the repo's first global
  settings table, with the admin form at `/admin/billing`, superadmin-gated
  via `getSuperadminContext()` and written through `recordAuditEvent`.
  Env-var bootstrap `FRAMEOS_CLOUD_AI_MARGIN_PERCENT` for a database whose
  row has not been written yet; the row wins once it exists.
- **Jobs** (done): `scripts/accounting-nightly.sh` + `ops/accounting/`
  systemd timer, sibling of the backup timers. It curls
  `POST /api/admin/billing/nightly` rather than doing the work itself —
  see Phase 4 for why.

### 5.1 The AI switch — an account may opt out entirely

Decided in §0: an account can turn AI features **off**, explicitly, and then
nothing it does can incur a cent of AI cost. This is not a billing feature
wearing a settings hat — it is the answer to a question people reasonably
ask about a metered product ("what stops this from running up a bill while
I'm not looking?") that a cap alone cannot answer, because a cap still
permits spending.

Shape:

- **Storage**: a nullable `ai_disabled_at` timestamptz on `accounts`, in the
  Phase 3 migration. A column rather than an `account_settings` row: the
  settings table stores per-group string maps (`filterAccountSettings`) and
  is written by the *shared frontend settings form*, which posts whole
  objects and is the wrong owner for a switch that must never be flipped by
  accident. `accounts` already carries exactly this kind of per-account
  product flag (`store_banned_at`, `verified_publisher_at`), and a
  timestamp answers "since when" for free, which a boolean does not.
- **Enforcement in one place**: `resolveAiCredentials()` returns `null` for
  a disabled account, *before* it looks at any key. Every AI surface already
  goes through it (scene chat, app chat, scene convert) and every one
  already handles null, so the switch cannot be forgotten at a call site
  that gets added later. The refusal needs its own error code, though:
  today null means `missing_api_key` / "OpenAI backend API key not set",
  which would be a lie here. Add `ai_disabled`, and have the routes
  distinguish the two — a disabled account being told to go set an API key
  is exactly the confusing dead end this switch is supposed to avoid.
- **What "off" does not touch**: an account's *own* OpenAI key. If a user
  has one and switches AI off, AI is off — the switch is about the feature,
  not about who is paying. (Doing otherwise would mean the switch means two
  things depending on state, which is worse than either meaning.)
- **Nor the scene converter.** Decided while building: `/api/scenes/convert`
  keeps calling `resolveAiCredentials` directly rather than the gate. It is
  an absorbed surface (§5) — billed to nobody, capped for nobody — and it
  has an anonymous path that needs no account at all, which is the proof it
  is not an account feature. Neither the switch nor the cap may turn a free
  migration tool we asked people to run into a refusal. The exemption is a
  comment at the call site, not an implicit consequence of the surface list,
  because the next person to read it will otherwise "fix" it.
- **UI**: a toggle in account settings, plus the same toggle reachable from
  the `/account/ai` page (§5.2), which is where somebody worried about cost
  is actually standing when the thought occurs to them. Turning it off states
  plainly what stops working; turning it back on is one click and audited
  (`recordAuditEvent`) in both directions.
- **Superadmin side** (built 2026-09-02, §9.3): the same flag, read and
  thrown from the customer statement page (`/admin/billing/customers`) via
  `PUT /api/admin/billing/customers/<id>/ai` — reason required, audited as
  `admin.ai_disabled` / `admin.ai_enabled` with the reason in the metadata.
  The terminal step of dunning (§3.2): an account that has not paid stops
  accruing before it stops being a customer. The same page moves an
  account between plans (`…/plan`, `admin.plan_changed` /
  `admin.plan_canceled`), non-public plans included and regardless of the
  self-serve gate — that gate exists because a *customer* subscribing runs
  up a receivable 3b cannot settle; an operator doing it with a reason on
  record is the exception it was written around.

### 5.2 "AI usage": a row in the header, a page behind it

Two surfaces, because they answer two different questions.

**The header row.** The account header
(`src/components/StorageUsageMeters.tsx`, rendered by
`app/account/layout.tsx`) shows a capacity meter per storage bucket and a
free-form last row for public scenes. AI usage joins as a row of that second
kind — a label and a dollar figure, no meter — because the only number it
could be metered against today is the daily cap, and a bar that fills every
day and empties overnight tells nobody anything:

```
Frames               ████░░░░░░  8 / 50
Private scenes       █░░░░░░░░░  8.8 KB / 100 MB
Backups              ░░░░░░░░░░  0 B / 100 MB
Frame logs           ██░░░░░░░░  5.2 MB / 100 MB
Public scenes                    109 MB · free
AI usage                         $1.27 this month →
```

The figure is this calendar month's `SUM(price_micros)` over
`ai_usage_records` for the account — the same rows the admin statement
drills into, so the user's number and ours are one query apart rather than
two definitions apart. While metering is in shadow mode `price_micros` is 0
on every row, so the honest display is the *would-be* price (cost × margin)
labelled as such: `$1.27 this month · not billed yet`. Four zero states, and
each needs its own words: nothing used yet, AI switched off (§5.1), running
on the account's own OpenAI key (they owe us nothing and must not be shown
a bill-shaped number), and no AI available to this account at all.

The row links to the page. It is not a modal: what people want when that
number surprises them is *which of my turns did this*, and that is a table,
a date range and a switch — a page's job.

**`/account/ai` — the page.** A new tab in `AccountNav`, alongside Installs,
Backups, Security, Developer and Activity, so it sits where every other
"about my account" answer already lives. Friendly first, forensic
underneath:

1. **This month, in one sentence.** "You've used $1.27 of AI this month.
   Nothing is billed yet while FrameOS Cloud AI is in preview." Then last
   month beside it, because the only way to know whether $1.27 is a lot is
   to see what $1.27 was last time.
2. **Where it went.** A breakdown by *surface* in the user's language —
   "Scene chat", "App code assistant", "Scene converter (free)", "Store
   classification (free)" — not by `surface` slug and not by model. The
   free ones are listed *because* they are free: an absorbed surface (§5)
   showing $0.00 next to a real number is the clearest possible statement
   of what we do and don't charge for.
3. **Recent turns.** Date, surface, the chat it belongs to (linked, when
   the chat still exists), and what it cost. Twenty rows and a "show more".
   This is the reconciliation surface: a user who disputes a number needs
   to be able to point at the turn.
4. **How pricing works.** Three sentences, not a schedule: we pay the model
   provider per token, we add a margin (the account's current one, named as
   a number), and the token counts and unit prices behind every turn are on
   record. Plus the daily cap and when it resets, and — once §0.1 exists —
   what the account's plan is and what a different one would have cost.
5. **The switch** (§5.1), at the bottom, stated plainly: what turns off,
   what keeps working, and that it takes effect immediately.

**Wire shape**: `GET /api/account/usage` gains an `ai` block —
`{ enabled, metering_mode, credential_source, month_price_micros,
month_cost_micros, previous_month_price_micros, today_price_micros,
daily_cap_micros, margin_basis_points }` — snake_case like the rest of that
payload because it crosses the AGPL boundary, and MCP's `account_quota`
picks it up for free (route first, thin tool after — house pattern). The
per-surface and per-turn detail is the page's own query rather than part of
that payload: `account_quota` is a "can I still do X" answer and has no
business carrying a hundred rows.

### 5.3 The daily cap

$10/day per account (§0), as `billing_settings.payg_daily_cap_micros` so it
is a superadmin edit rather than a deploy (the field is on the form since
2026-09-02), with a per-account override column for the accounts that
eventually need one (*not built*).

**Two caps, since 2026-09-02 (§9.3).** The cap counts every turn on one
of *our* keys, which for an account on the operator's shared key
(`FRAMEOS_AI_SHARED_KEY_ACCESS`, the free tier) meant being "limited" at
$10 on money it does not owe, and seeing a dollar figure with "nothing is
billed" under it. The shared key now has its own
`billing_settings.shared_key_daily_cap_micros` — our money, our (usually
smaller) number; it falls back to the main cap until set — and the
refusal says whose allowance ran out: the 402 body carries
`allowance: "shared" | "billable"`, the panel's copy and `/account/ai`'s
wording differ accordingly, and the nightly check judges a shared-key
account-day against the shared ceiling. `resolveAiAccess` picks the cap
from the credential source it already resolved, so it is one query either
way.

- **Measured** as `SUM(price_micros)` over the account's `ai_usage_records`
  for the current UTC day. Not the ledger: the cap must hold for shadow-mode
  and own-key accounts too (where nothing posts), and it must be a cheap
  indexed query on the hot path of every turn.
- **Checked before a turn, never during.** A turn's cost is unknown until it
  ends, so the cap is necessarily approximate: the last turn of the day can
  cross it. That is the same accepted overshoot the prepaid design called an
  overdraft, and `payg_overdraft_micros` already exists to size it — worst
  case one turn's worth, which is why the cap is $10 and not $10,000.
- **Refusal**: `jsonError("daily_cap_reached", 402)` with the cap, the
  day's spend and the reset time in the body, rendered by the SPA's AI panel
  as its own state rather than as a generic error (the panel has had the
  state since 2026-09-02). It resets at midnight UTC and the message says
  so.
- **Refused at the cap, stopped at the overdraft.** The gate refuses a new
  turn once the day's chargeable usage has reached the cap. A turn already
  running keeps its own tally (`access.budget` from `resolveAiAccess`, priced
  round by round the way metering will price it) and is aborted once the
  day would pass `cap + overdraft` — which is what bounds a long tool loop,
  the thing "one turn's overshoot" never bounded on its own. The nightly
  check tolerates exactly that much.
- **`payg_overdraft_micros` keeps its meaning** and loses its old job: it no
  longer guards a prepaid balance going negative (there is no balance), it
  sizes the cap's permitted overshoot.
- **Watching it**: the nightly job runs `checkDailyCapRespected` — invariant
  5's replacement — over every account-day, which is the only automated proof
  that the gate sits in front of *every* AI surface rather than most of them.
  A surface added next month that forgets to call `resolveAiAccess` shows up
  as a day over the line rather than as a surprise on an invoice. It reports
  and never repairs, like everything else in that job.

---

## 6. Invariants (the smoke-test suite)

Each is (a) a vitest integration test and (b) a nightly checker query that
alerts (`reportError`) on violation. They are the same code in both cases —
`packages/ledger/src/integrity.ts` — which is the point: one definition of
"the books are consistent", proven on fresh data by the suite, on production
data by the nightly job, and shown live on `/admin/billing`.

1. **Every entry balances**: per `entry_id` per currency,
   SUM(debit amounts) = SUM(credit amounts).
2. **Accounting equation**: assets + expenses + contra-revenue = liabilities
   + equity + revenue, each account signed by the side its *type* says is
   normal — and every account's stored `normal_side` agrees with its type.
   (Summing raw debits against raw credits, which this used to do, is
   implied by check 1 and catches nothing; the type-side disagreement is
   the thing double entry cannot catch on its own.)
3. **Cache is honest**: `ledger_balances` = SUM(postings) per account,
   exactly.
4. **Events post exactly once**: no `processed_at IS NULL` older than N
   minutes; no two entries of the same `entry_type` for one event unless the
   recipe declares multiplicity.
5. **The daily cap held** (`checkDailyCapRespected`): no account, on any UTC day, has metered more
   than the cap in force plus one turn's permitted overshoot
   (`payg_overdraft_micros`). This replaces the prepaid "no negative credit
   balance" check — same job (nobody spends past the line we drew), same
   place, different line — and it is the only automated proof that the gate
   in §5.3 is actually wired in front of every AI surface rather than most
   of them. Its companion is a *report*, not a violation: a customer
   receivable sitting on the credit side means we owe them money, which
   under postpay is legitimate after a promo grant and suspicious
   otherwise.
6. **Metering completeness**: every *live, billable* `ai_usage_records` row
   has `event_id` set after the sweep. Narrow on purpose — a shadow-mode
   record posts nothing by design and an own-key turn cost nothing and is
   charged nothing, so neither is a violation. The external cross-check
   (every finished turn has a record: count vs `ai.chat.turn_finished` logs
   / PostHog) is the shadow-period comparison in Phase 2, not a query.
7. **Reversals mirror**: an entry with `reverses_entry_id` has legs exactly
   negating its target.
8. **Immutability**: the update/delete triggers exist and fire (tested by
   attempting an UPDATE and expecting the exception).
9. **Deferred subscription revenue is its periods**
   (`checkDeferredSubscriptions`): the balance of
   `liability:deferred:subscriptions` equals Σ(`price − refunded`) over
   periods charged and not yet recognised. A vanished period row or a
   recognition that ignored a refund both show up here.
10. **Prices came from the table** (`checkPricesCameFromTheTable`): no turn
    in the last day priced off the code fallback. A new model id is an
    alert the night it first runs, not a 2.5× surprise on an invoice.

Plus Airbnb-style **golden-file lifecycle tests**: scripted scenarios
asserting the full journal and every balance at each step. The live one
walks the postpay path (3 turns → the cap refuses a fourth → month close →
invoice → payment → fee → reversal); Phase 5 adds the subscription walk
(§3.6); and §3.5's shelved prepaid recipes keep a walk of their own
(purchase → spend → refund), which is what stops a shelved model from
quietly rotting into something that no longer compiles.

---

## 7. Implementation phases (the todo)

### Phases 0 and 1 — shipped 2026-08-31

Migration `0042_accounting_ledger.sql` (the six tables, the check
constraints, the append-only triggers, the seeded groups and system chart)
with matching `schema.ts` blocks, and `packages/ledger`: the `postEvent`
kernel, `ensureLedgerAccount` + chart codes, the `manual_journal` and
`reversal` recipes, `integrity.ts` (checks 1–5, 7, 8) and `balances.ts`.
Twenty-one integration tests cover the happy path, idempotent replay, rollback
of an unbalanced draft and of a caller-owned transaction, concurrent
posting to one account, the reversal round-trip, the triggers firing, and
the books surviving deletion of the account they billed — still attributed
to it, including the provider-cost entry that names no customer account
(§2.1). The remaining Phase 0 decisions that only bind later phases are
in §8.

### Phase 2 — meter AI usage — shipped 2026-08-31 (shadow mode)

Migration `0043` (`ai_usage_records`, `ai_model_prices` seeded with gpt-5.5,
gpt-5.6-luna/sol/terra and gpt-4o-mini, `billing_settings` seeded with a 30%
margin, a $1 overdraft and `ai_metering_mode = shadow`), `pricing.ts`,
`settings.ts`, `metering.ts` and the `ai_usage` recipe. Every OpenAI call
site now meters: the scene chat (from the turn runner's `onFinish`, so a
detached or resumed turn still posts), app-chat (which now resolves its key
through `resolveAiCredentials` like everything else instead of reading the
account setting directly), the public scene converter, and the store
classifier at both publish and recategorize. Invariant 6 covers metering
completeness, and the golden-file lifecycle test walks a customer from
purchase through usage, reversal and reclassification asserting the whole
journal at each step.

Two things worth knowing before Phase 3 builds on it:

- **The mode is stamped per record, not read at sweep time.** Flipping
  `ai_metering_mode` to live therefore cannot retroactively bill the shadow
  period — those rows stay unposted forever unless somebody deliberately
  backfills them, which is exactly the decision Phase 4 leaves open below.
- **`credential_source: "platform"` has no producer yet.** Nothing is
  billable until Phase 3 teaches `resolveAiCredentials` to return it, so the
  charge half of the `ai_usage` recipe is exercised only by tests. That is
  the shape "shadow mode" actually takes: there is no customer to charge,
  rather than a charge being suppressed.

Still open, and the gate on Phase 3:

- [ ] Run a week in production and compare `ai_usage_records` totals against
      PostHog `$ai_generation` sums **and against the provider's own
      invoice** — the second comparison is the one that settles §8.2.
      **Scripted 2026-09-02** as
      `apps/auth-web/scripts/ai-metering-compare.mjs` (three optional
      sides — `DATABASE_URL`, PostHog personal key + project, OpenAI *admin*
      key — compared per UTC day and model, token vocabularies normalised,
      exit 1 above 1% disagreement) so it re-runs on the next model change.
      First run: see §9.6 — there was no week to compare yet.

### Phase 3 — postpay billing (first revenue)

Rewritten 2026-09-01 for §0. The prepaid checkout this phase used to be is
now §3.5's shelf recipe; what ships instead is metering that charges a
receivable, a daily cap, a visible number, an off switch, and one invoice a
month.

It splits at the payment provider, and the split is worth respecting because
the first half is unblocked and the second is not.

**Phase 3a — everything that does not need a provider — shipped 2026-09-01.**
Migration `0044` (`accounts.ai_disabled_at`, the `payg_daily_cap_micros`
setting at $10, an `(account_id, occurred_at)` index), the AI switch, the
daily cap, the `ai` block on `GET /api/account/usage`, the account header's
"AI usage" row and the `/account/ai` page behind it.

- [x] The AI switch (§5.1): `resolveAiAccess()` in
      `src/lib/ai/api-key.ts` is now the one door every AI surface goes
      through — switch, then key, then cap, in that order. It replaces a
      `null` that meant three unrelated things with a typed refusal, and
      `src/lib/ai/access.ts` turns each into its own status code: 403 for a
      switch the user threw, 402 for the cap, 400 for a genuinely missing
      key. Audited both ways through `PUT /api/account/ai`.
- [x] The daily cap (§5.3): `accountAiSpendMicros()` in
      `packages/ledger/src/account-usage.ts`, checked before a turn, and
      `checkDailyCapRespected` as invariant 5's postpay replacement.
      **The chargeable amount is defined once and used twice** — by the cap
      and by the page — because two definitions of "what you have spent
      today" that differ by a rounding step is a bug only ever found by a
      confused user. It is not `SUM(price_micros)`: in shadow mode that is
      zero on every row, so the cap would never bite and would ship
      untested. It is what the turn *would* be billed at, from the row's own
      pricing snapshot.
- [x] `GET /api/account/usage` carries an `ai` block, built inside
      `accountUsage()` rather than in the route, so the payload and the
      header component share one definition. MCP `account_quota` picks it up
      for free.
- [x] Account header: the "AI usage" row, with the shadow-mode "not billed
      yet" wording and all four zero states.
- [x] `/account/ai`: this month and last, the per-surface breakdown in the
      user's words with the absorbed surfaces shown as free, the last twenty
      requests, how pricing works, and the §5.1 switch. A new `AccountNav`
      tab.
- [x] Tests: the refusal shapes, the cap invariant (including that own-key
      turns and absorbed surfaces stay out of it), the window arithmetic,
      and the subscription golden file.

**Phase 3b — the provider half.** Blocked on §8.7, and the requirement is
now stricter: postpay needs a payment method stored and chargeable later,
not a one-off hosted checkout (§3.2).

- [ ] Choose the provider; SDK + env plumbing; webhook endpoint
      `app/api/webhooks/<provider>/route.ts` (signature check, provider
      event id as idempotency key, raw-body handling).
- [ ] Migration `0048` (0045 went to plans, 0046 to the §9 fixes, 0047 to
      §9.3's daily recognition): `invoices` (period bounds,
      sequential number, status, provider payment ref) and the
      stored-payment-method reference. The
      invoice holds no amount the ledger does not — §3.2 says why.
- [x] `ai_usage` rule **v2** (done 2026-09-01, ahead of the rest of 3b
      because a subscription accruing on the receivable while metered usage
      drew down a prepaid liability would have been two models in one book):
      the charge leg debits `asset:receivable:customer:<id>` (§3.1). A
      version bump, not a re-model. Nothing had posted under v1 — metering
      has been in shadow throughout — so no historical entry means anything
      different than it did.
- [ ] `source: "platform"` in `resolveAiCredentials` — the thing that makes
      any of this billable at all, and still gated by §5.1 and §5.3 before
      it is reached. The scene converter stays out of it: it is an absorbed
      surface (§5), so it books pure cost when the billable key reaches it,
      and neither the cap nor the switch may turn a free surface into a 402.
- [ ] Month-close run in the nightly job: cut invoices over the period's
      receivable, skip balances under the minimum threshold (§3.2), charge
      the stored method.
- [ ] Recipes: `invoice_payment`, `psp_fee`, `receivable_writeoff`, and
      `promo_grant` against the receivable (§3.4).
- [ ] Dunning: retry schedule, the age at which AI switches off for an
      unpaid balance, the emails. Reads the receivable, writes none of it.
- [ ] Flip `ai_metering_mode` to `live` — after the Phase 2 gate below is
      satisfied, not before.
- [ ] Golden-file test: turns → cap refusal → month close → invoice →
      payment → fee → an unpaid month → write-off.
- [ ] Legal/pricing page copy: that AI is billed monthly in arrears, that
      a plan is billed in advance for the coming period (§0), what the
      margin is, what the cap is, and how to turn it off. Plus §8.8's
      billing-records retention line, which must land before the first
      invoice, not after — and §8.15's answer (which entity invoices).

### Phase 4 — books you can actually read + ops — shipped 2026-08-31

`/admin/billing` in four views: the trial balance (with the 30-day revenue /
cost / margin / liability tiles and the invariants run live on every
render), the journal browser with account/type/customer/event filters and
per-entry reversal, the chart of accounts with group re-mapping, and the
per-customer statement with a running balance and the metered turns behind
it. Posting by hand — manual journal and reclassification — goes through
`POST /api/admin/billing/journal`, superadmin-gated, reason-required and
audited; the `reclassification` recipe is mechanism 2 of §1.3, deliberately
*not* using `reverses_entry_id` (that column promises a leg-for-leg
cancellation, which the integrity checker proves, and a reclass is not one).
Settings and groups have their own audited routes.

The nightly job is `scripts/accounting-nightly.sh` +
`ops/accounting/frameos-cloud-accounting.timer`, and it is a curl rather
than a script that does the work: `POST /api/admin/billing/nightly` sweeps
unposted records, runs every invariant, `reportError`s each violation and
logs the daily summary line. The reason is one definition of "consistent" —
the invariants are TypeScript the test suite already proves, and a
psql sibling of `db-cleanup.sh` would have been a second copy of every query
drifting from the first. (It cannot be a Node script either: the release
bundle is Next's standalone output and carries no tsx, the same reason
`object-store-sweep.sh` is bash.) It authenticates with a superadmin API
token — an auth mechanism that already exists rather than a new secret.

The job reports and never repairs. Books that disagree with themselves need
a human; a quiet automatic "correction" is how a discrepancy becomes
undiscoverable.

§8.10 was settled by building the statement view: names are resolved live
from `accounts` and degrade to the bare uuid, so an erased customer's
statement reads "deleted account" and stays complete. That stops working the
day accounting moves to its own database (§7 Phase 6) — which is when a
deliberate customer-label table becomes the answer, and not before.

Decided since:

- [x] **Backfill: no.** The books start at go-live rather than fabricating a
      history for the shadow-mode period. The shadow records stay where they
      are with `event_id IS NULL`, the sweep is built to ignore them, and
      invariant 6 is narrow on purpose so that this is a decision rather
      than a permanent alarm. It costs nothing: nobody was charged for those
      turns, so there is no receivable to reconstruct — only measurements,
      which we still have.

### Phase 5 — plans and subscriptions (§0.1) — shipped 2026-09-01

Un-shelved and built the same day it was un-shelved, which is the payoff for
§3.6 having been designed rather than merely deferred: no posting rule
changed, `rules/ai-usage.ts` still does not know that plans exist, and the
whole of it is schema, a lifecycle job and three two-leg recipes.

- [x] Migration `0045`: `billing_plans` (code, name, price, period,
      `margin_basis_points`, entitlements jsonb), `subscriptions`,
      `subscription_periods`. Seeds §0.1's ladder **including PAYG as a real
      row** at $0/100%, so "what plan is this account on" always has an
      answer and the margin lookup has no special case.
- [x] Recipes `subscription_charge`, `subscription_recognition`,
      `subscription_refund_to_receivable` (`rules/subscription.ts`), and the
      lifecycle in `subscriptions.ts`: open the periods that are due, charge
      the ones that have started, recognize the ones that have ended. Every
      step is idempotent on its period row, so the nightly job may run twice
      in a night or miss three nights without double-charging anybody or
      losing a period — and a job that has not run for two months opens both
      months, because both were served. Never from before the subscription's
      `started_at`, which a return after a cancellation resets: the months in
      between were not served (§9.2 item 2, fixed 2026-09-02). The first
      period opens and charges the moment a plan is taken, not at the next
      nightly run.
- [x] Per-plan margin: `accountMarginBasisPoints()` resolves the plan's rate
      and `metering.ts` snapshots it into the record exactly as it always
      snapshotted the global one, so a plan change is never retroactive.
- [x] Per-plan entitlements: `accountLimits()` in `src/lib/usage.ts`, and
      **every enforcement point moved onto it** — backups, private scenes at
      all four write paths, the frame-log cull, and (since 2026-09-02) the
      frame count at enroll and claim-token minting. A display that promises 10 GB
      while the refusal still fires at 100 MB would be worse than having no
      plans at all.
- [x] Nightly: `runSubscriptionCycle` runs between the usage sweep and the
      invariants — the invariants have to see the books *after* everything
      that was going to be written tonight has been, or they report a
      disagreement they caused themselves.
- [x] `GET/PUT /api/account/plan`, the plan on `/account/ai`, and the
      cancel-at-period-end flow.
- [x] Golden file (`subscriptions.integration.test.ts`): subscribe →
      charge → the same night again charges nobody twice → meter a turn at
      the *plan's* margin rather than the deployment's → recognize once the
      period has actually been served → refund the unearned remainder to the
      receivable → cancel and expire on time.

Three decisions taken while building, each of them a place where the obvious
thing would have been wrong:

- **Self-serve purchase is gated off** behind `FRAMEOS_CLOUD_PLANS_SELF_SERVE`,
  default false. Subscribing accrues a real receivable, and Phase 3b — the
  provider, the stored payment method, the month-end invoice — does not
  exist. Letting somebody subscribe today would run up a balance with no way
  to settle it: the ledger would be right and the customer would be stuck.
  Downgrading to the free plan is never gated; refusing to let somebody stop
  paying us would be an unpleasant thing to build.
- **An account nobody put on a plan prices at the deployment's global margin,
  not at PAYG's 100%.** Otherwise migration 0045 would have doubled the
  price of every existing account's AI on the night it ran — a price change
  wearing a schema change's clothes. PAYG's own margin applies once somebody
  is deliberately on it, and §8.13's "what are the numbers really" question
  is the one that should move this.
- **Entitlements take the larger of the plan and the deployment's env floor.**
  An operator who raised `FRAMEOS_CLOUD_MAX_BACKUP_MB` for everybody must not
  have it silently lowered by a plan row, and the seeded PAYG numbers are
  deliberately identical to the historical free tier so that nothing anybody
  has today gets smaller.

Still open, and genuinely Phase 6 rather than hidden work: the
cloud-rendered-frame entitlement (§0.2) is carried in the plan row and
enforced nowhere, because no frame is cloud-rendered yet. It becomes a count
check at frame creation plus the minimum-refresh-interval floor the day thin
clients land — which is the product this entitlement exists to unblock.

### Phase 6 — later, enabled by the above, not designed in detail here
- [ ] Bank/PSP reconciliation: import the provider's payout reports + bank
      statements, match on `external_ref`, `reconciliations` table,
      unmatched-items report. (`asset:psp:main` vs payout lines is the
      first match target; the accrued-OpenAI account vs their invoices the
      second.)
- [ ] Postpay: credit limits, invoicing, receivables aging.
- [ ] Storage/other metered products: new event types + recipes only.
- [ ] Multi-currency: EUR chart siblings, FX gain/loss account.
- [ ] Refund self-service UI on the §3.6 cash-refund path (the
      net-against-receivable case Phase 5 builds covers most of it).
- [ ] **Accounting in its own Postgres database** (stated intention,
      2026-08-31). §2.1 already pays the entry price: no ledger table
      references anything outside the ledger, and a schema test over every
      billing table fails if one ever does (0045 slipped a cascading FK past
      the first version of that test; 0046 removed it — §9.2 item 4), so the
      tables can be dumped and restored elsewhere as a unit. What still has to be answered when it happens: the kernel takes
      a `LedgerExecutor` so callers can post inside *their* transaction
      (§4.1) — two databases means that guarantee is gone for the
      purchase/webhook paths, and they need either an outbox in the product
      database or an accepted window where the payment row and its entry can
      disagree. Nothing about the schema changes; the atomicity story does.
      Decide it before splitting, not after.

---

## 8. Open decisions

Numbered from the original Phase 0 list; §0 closed several of them by
narrowing the product, and closed items are kept in place with what closed
them rather than deleted, because "why isn't there a credit balance" is a
question that will be asked again.

1. **Credits display unit** — ~~plain dollars, or "credits" at 1 credit =
   $0.01?~~ **Closed by §0**: there is no credit balance to display. The
   account page shows dollars of usage (§5.2), which is not a currency
   question at all.
2. **Reasoning-token pricing** — still open, and now measurable. The
   implementation assumes reasoning bills as output (it is a subset of
   `output_tokens`, recorded separately for analysis and never priced on its
   own), so `ai_model_prices` has no third column. Verify against the
   provider's actual invoice line items during the shadow period; if it
   turns out to be wrong the fix is a column plus a rule-version bump, not a
   re-model.
3. **Shared-key tier** — what happens to `FRAMEOS_AI_SHARED_KEY_ACCESS`
   once the PAYG plan exists? Today it is the operator's free tier and we
   absorb it as COGS; §0.1 gives every account a billable path, which makes
   the shared key redundant for anyone on this deployment and still
   necessary for a self-hoster who wants to give their users AI. Lean: it
   stays, and it stops applying to accounts on a plan. If it instead becomes
   a *free monthly allowance*, the shape is a monthly `promo_grant` against
   the receivable (§3.4) rather than a promo balance — which is also how
   §0.1 would express "your first $2 of AI each month is on us" if a plan
   ever wants that.
4. **Overdraft size** — one turn can cost ~$0.50+, and its cost is unknown
   until it ends, so the last turn of the day can cross the cap. Proposal
   unchanged in size, changed in meaning: `payg_overdraft_micros` (default
   $1) now sizes the *cap's* permitted overshoot rather than a prepaid
   balance's permitted negative (§5.3).
5. **Credit expiry** — ~~legal/VAT implications differ by jurisdiction
   (unused prepaid balances are liabilities indefinitely unless terms say
   otherwise).~~ **Closed by §0**: nothing is prepaid, so there is no
   unused balance to expire, no dormancy question, and no
   unclaimed-property exposure. This decision disappearing was one of the
   arguments *for* postpay, not a consequence discovered afterwards.
6. **VAT/sales tax** — out of scope above, but EU sales likely need it
   sooner than reconciliation does. When it lands: a `liability:vat_payable`
   account plus tax legs in the purchase/subscription recipes. Who owes it
   depends on §8.7: a merchant-of-record provider remits it themselves and
   the money reaching `asset:psp:main` is already net, while a direct PSP
   leaves the liability with us (Stripe Tax can compute the amounts, but
   computing is not remitting). Flagged now so the recipes are written with
   a third leg in mind.
7. **Payment provider** — undecided, and the code no longer assumes one.
   `asset:psp:main` names the role, `invoices` carries a `provider` column,
   and §3.2's recipes hold for anything that reports a successful payment,
   a fee and a stable payment id. §0 made the *requirement* stricter
   without making the choice: postpay needs a payment method **stored and
   chargeable later**, not a one-off hosted checkout, which rules out the
   simplest integration of several candidates and should be checked before
   picking one. The choice is a product/tax
   decision rather than a schema one, and the sharpest part of it is §8.6: a
   merchant-of-record (Paddle, Lemon Squeezy) collects and remits VAT for
   us, which removes a liability and a compliance burden at the cost of a
   higher fee; a direct PSP (Stripe) leaves both with us. Decide it before
   Phase 3 writes a webhook, not after.
8. **Retention wording in the privacy policy** — §2.1 keeps account uuids in
   the books after erasure, deliberately. `/legal/privacy` currently promises
   only that account data "goes, along with your frames, scenes, files and
   backups" and that the security trail is kept "with your account identifier
   removed". Billing records need their own line (kept as long as bookkeeping
   law requires, identified by an internal id only) before we take the first
   payment. Separately and already true on main: the audit trail's stated
   de-identification is not what the code does — `recordAuditEvent` keeps
   `actor.accountId`, and the self-delete event keeps the email in
   `metadata` — so either the jsonb is scrubbed on delete or that sentence
   changes. Not an accounting bug; found while deciding §2.1.
9. **Per-frame attribution** — nothing in the ledger names a frame today, and
   AI usage is per-account, so nothing needs it yet. It starts mattering the
   moment a per-device product is metered (cloud rendering for thin clients,
   storage — §7 Phase 6, tangled with the unanswered "free cloud rendering
   forever" question in `docs/todo.md`). When it lands: `frames` *cascades*
   from `accounts`, so a foreign key would be useless here for the same
   reason §2.1 gives — carry the frame uuid unreferenced, and snapshot the
   frame name into the event payload, because a uuid whose row is gone is a
   discriminator without a label.
10. **Do events carry an identity snapshot?** — **decided 2026-08-31 by
    building Phase 4's statement view: resolve live, degrade to the uuid.**
    `apps/auth-web/src/lib/billing-admin.ts` looks the name up in `accounts`
    and renders "…(deleted account)" when it is gone, so the books hold no
    identifying data past erasure and a statement stays complete and
    attributed without one. Revisit only if support finds the bare uuid
    unworkable — and note the expiry date on this answer: it stops working
    the day accounting moves to its own database (§7 Phase 6), which is when
    a ledger-owned customer-label table becomes the answer. The reasoning
    that led here, kept because the trade-off will come back: it gets
    sharper the further §2.1 is taken. A uuid is a discriminator, not a
    label: nothing in the ledger can say *whose* books these are without
    joining `accounts`, and that join is impossible after erasure and
    impossible by construction once accounting has its own database (§7
    Phase 6). Phase 4's "account statement per customer" therefore needed a
    name from somewhere. Options:
    write `{email, displayName}` into the event payload at post time (the
    books read standalone, at the cost of holding identifying data past
    erasure — which is exactly what §2.1 avoids); resolve names live and show
    the bare uuid when the lookup fails (honest, ugly for support); or a
    separate customer-label table the ledger owns, populated at first touch
    and cleared on erasure (a third thing to keep in sync). Lean: resolve
    live, degrade to uuid — which is what shipped.
11. **Where `expense:bad_debt` reports** — `cost_of_revenue` alongside COGS
    and PSP fees, or its own group? It is not a cost of *producing* the
    service (we already booked that as COGS when the tokens burned); it is
    a collection failure. Lean: its own group, so gross margin stays a
    statement about the product and not about who paid. Trivial to change
    later — §1.3 mechanism 1 re-maps a group with zero accounting impact,
    which is exactly the kind of decision that machinery exists for.
12. **What day the daily cap counts** — UTC, or the account's own timezone?
    UTC is what Phase 3a will implement (one definition, one index, no
    per-account arithmetic on the hot path of every turn) but it means the
    reset lands mid-afternoon for some users, and "resets at midnight" is
    then a small lie on the `/account/ai` page. Frames already carry a
    timezone and
    `docs/` has a history of UTC-vs-local bugs on exactly this pattern
    (ESP32 clock handling, SD-card cards). Decide before the copy in §5.2 is
    written, because the honest UTC wording is different from the honest
    local one.
13. **Plan numbers** (§0.1) — the three margins are decided (100/50/20) and
    everything else in that table is a proposal: $1.99/$6.99, 5/25
    cloud-rendered frames, 2 GB/10 GB of backups. What would settle them is
    a month of live metering (Phase 3b) showing what a real account actually
    burns — the crossover arithmetic in §0.1 is only as good as the ~$0.44
    per turn it assumes, and that figure comes from one worked example, not
    from a distribution. Decide the frame counts against a capacity plan
    rather than a feeling (§0.2 does the CPU arithmetic; nobody has done the
    "how many accounts per box" half).
14. **Whether AI is off by default for new accounts.** §0 says users can opt
    *out*, which presumes in. That is right while metering is in shadow
    mode and everything is free. It stops being obviously right the day
    Phase 3b makes a turn cost money: "signed up and immediately started
    accruing a bill" is a defensible default only if the first thing the
    product shows is what it costs. Tied to §8.3's allowance question — a
    free monthly allowance makes opt-in-by-default unremarkable, and no
    allowance makes it a decision worth being deliberate about.
15. **Which legal entity invoices, and from where** (raised by §9.3,
    2026-09-02; *a decision only the owner can take*, and it comes before
    §8.7's provider choice, not after). Nothing in this document or the
    code names the party on the invoice. What has to be settled, in order:
    - **The entity.** The name, address and registration that go on
      `invoices` — presumably the operating company, but "presumably" is
      not a line on an invoice.
    - **Its VAT position.** Registered or not; if registered, the number
      goes on every invoice and §8.6's `liability:vat_payable` leg becomes
      real for domestic B2C sales the day the first invoice is cut.
    - **Gapless numbering.** Many EU jurisdictions require invoice numbers
      to be sequential without gaps, per entity (sometimes per series).
      `invoices.number` was designed for that and nothing assigns it; the
      assignment must be a database sequence taken inside the same
      transaction that creates the invoice, never a counter in the app,
      and a voided invoice keeps its number. If the entity's jurisdiction
      does not require it, do it anyway — it is cheaper than the argument.
    - **OSS / cross-border B2C.** Selling to consumers in other EU member
      states above the €10k union-wide threshold means charging the
      *customer's* country's VAT and remitting through the One-Stop-Shop
      — or letting a merchant-of-record do it (§8.7 again). Below the
      threshold, home-country VAT. Either way the invoice needs the
      customer's country, which `accounts` does not hold today.
    - **B2B reverse charge.** A customer with a valid VAT number in
      another member state is invoiced net with the reverse-charge
      wording; needs a VAT-number field and a VIES check.
    Until these are answered 3b's invoice has no header, and the recipes
    in §3.2 have no tax leg. Decide, then write the answers into this
    item.

---

## 9. Review of what shipped — 2026-09-01

A read of every file in `packages/ledger`, migrations 0042–0045, every
call site that meters or gates, the admin and account surfaces, the tests
and the ops units, against this document. Four PRs (#423, #425, #427 and
#424's absorbed-surface change) landed in two days; this is the pass that
should have happened between them. Verdict first: **the kernel and the
money model are right and worth keeping exactly as they are. The layer on
top of them — gates, plans, subscriptions, the two pages — has one
exploitable hole, three real accounting bugs, and a plan ladder whose
numbers do not do what §0.1 says they do.** Nothing here touches a
customer yet (shadow mode, self-serve off), which is exactly why it is the
right moment to fix it.

### 9.1 What is good, and why it should not be touched

- **The kernel is the design proving itself.** One writer, idempotent on
  a key that stands for one fact, balanced per currency inside the
  transaction, balance rows taken in sorted order, codes canonicalised so a
  customer cannot be split across casings, and append-only enforced by the
  database rather than by promise. The tests that matter exist: replay,
  rollback of an unbalanced draft, concurrent posting to one account, the
  triggers actually firing, and the books surviving the deletion of the
  account they bill. Keep all of it.
- **Events → rules → postings held under pressure twice.** Postpay was a
  `version: 2` bump on one rule; plans added three two-leg recipes and
  `rules/ai-usage.ts` still does not know they exist. That is the property
  §1 promised and it is the reason the fixes below are all small.
- **Money handling is correct in the places that are usually wrong.**
  Bigint micro-dollars, prices per million tokens (per-token could not
  represent a cached gpt-4o-mini token), one rounding step per record,
  amounts as decimal strings through jsonb, disjoint token counts with one
  door (`splitProviderUsage`) for the provider's overlapping ones.
- **Record-before-post plus a sweep** is the right at-least-once shape,
  and stamping `metering_mode` per row (so flipping to live cannot
  retroactively bill the shadow period) is the kind of decision that is
  obvious only after somebody has been bitten by the alternative.
- **No foreign key out of the ledger**, with the reasoning written down
  in three places and a test — for the 0042 tables (§9.2 item 4 is about
  the tables that came after).
- **Reversal vs reclassification** is a real distinction with an invariant
  behind it, and the admin journal route refuses to post without a reason.
- **The nightly job as an endpoint** — one definition of "consistent",
  report-never-repair, dead-man ping — is the right call for a standalone
  Next bundle with no tsx.
- **The document itself.** Every decision carries its reason and its
  reversal. That is what made this review possible in an afternoon, and
  it is what makes §9.4's list of places where the doc and the code have
  drifted a list rather than an archaeology.

### 9.2 Mistakes that need fixing, most serious first

1. **The metered surface is client-controlled, and the surface decides
   whether a turn is billable.** `app/api/ai/chat/route.ts` gates with the
   literal `"scene_chat"` but meters `body.surface` verbatim (line 348),
   which is why the records say `editor` / `frame` / `store` /
   `store-new` and `/account/ai` needed a second label map. A client that
   sends `surface: "scene_convert"` gets a turn that `billing()` in
   `metering.ts` treats as absorbed: `price_micros = 0`, no charge entry
   once metering is live, zero against the daily cap, and a "free" pill
   on their own usage page. Today that is a cap bypass; the day
   `platform` credentials exist it is free AI for anyone who reads the
   network tab. **Fix:** the record's `surface` is the gate's surface, an
   enum the server owns; the client's hint becomes a separate `context`
   (or a key in the pricing snapshot) that nothing prices on. Add the test
   that sends `scene_convert` from the client and asserts the turn is
   charged. Then decide what the existing `editor`/`frame`/`store` rows
   should be called (they are shadow rows, so a one-off `UPDATE` is
   honest — the metering subledger is not the journal).
2. **Re-subscribing after a gap bills the gap.** `setAccountPlan` keeps
   `started_at` on conflict, and `openDuePeriods` starts the next period
   at the *latest period's end*, catching up "because both months were
   served" (§7 Phase 5). An account that subscribed to Maker, cancelled,
   and comes back to Studio six months later gets six Studio periods
   opened and charged to its receivable the same night — for months it
   was not subscribed. **Fix:** a subscription's periods may not start
   before its current `started_at`; on re-subscribe from `canceled` (or a
   passed `cancel_at`) set `started_at = now` and start from there.
   Catch-up stays, bounded to the interval the row was actually active
   for. Test: subscribe → cancel → wait two months → subscribe → exactly
   one period.
3. **The cap gate and the cap invariant disagree by one overdraft.**
   `resolveAiAccess` refuses at `spent >= cap + overdraft` (api-key.ts
   line 127); `checkDailyCapRespected` tolerates up to `cap + overdraft`.
   So the effective cap is $11, and a turn legitimately started at $10.99
   that costs 50¢ is reported as a violation every night. **Fix:** the
   gate refuses at `spent >= cap`; the overdraft is the invariant's
   tolerance, as §5.3 already says. Two adjacent things the same fix
   should absorb: (a) N concurrent turns each pass the gate and can each
   overshoot — either reserve in flight or accept it and widen the
   tolerance to a few turns rather than one; (b) a turn's cost is not
   bounded by the overdraft at all, because a tool loop of many rounds is
   one turn — the runner needs a per-turn budget (re-check the cap between
   rounds, or a max-rounds that implies a max cost), or "$1 of overshoot"
   is a wish rather than a bound.
4. **Migration 0045 broke the §2.1 rule, and account deletion now leaves
   the books wrong.** `subscriptions.account_id REFERENCES accounts ON
   DELETE CASCADE`, and `subscription_periods` cascades from that. Delete
   a subscriber mid-period: the charged-but-unrecognised period row
   vanishes, so `liability:deferred:subscriptions` keeps a balance no row
   accounts for and nothing will ever recognise or refund it; the
   receivable for that period stays open with no way to net the unearned
   part against it. The schema test that §7 Phase 6 says would catch this
   only covers the six 0042 tables — `ai_usage_records`, `billing_settings`,
   `billing_plans`, `subscriptions` and `subscription_periods` are outside
   it. **Fix:** plain uuid on `subscriptions.account_id` like everything
   else; the schema test enumerates every billing table (ideally by
   name-prefix or a shared marker, so the next table cannot be forgotten);
   `POST /api/account/delete` closes the subscription out *before* the
   cascade — refund the unearned remainder to the receivable (§3.6), then
   leave the receivable to the write-off decision. And an invariant:
   `liability:deferred:subscriptions` equals the sum of
   `price_micros` over periods with `charged_at` set and `recognized_at`
   null, less refunds — today nothing checks that account at all.
5. **The plan ladder is upside down for every existing account.** An
   account with no subscription row prices at the *global* margin (30%),
   deliberately, so that migration 0045 would not double anyone's price
   overnight — the right instinct. But the PAYG row says 100%, Maker 50%,
   Studio 20%, so **Maker is a worse AI rate than doing nothing**, and
   Studio only beats the default by ten points for $6.99. The
   `/api/account/ai` payload says both at once: `margin_basis_points:
   3000` next to `plan.margin_basis_points: 10000`, and the page says "You
   are on the Pay as you go plan" while charging 30%. §0.1's crossover
   arithmetic (Maker pays for itself at ~$4 of provider cost) assumes a
   100% baseline that nobody is on. **Fix:** one number for "the margin
   when you have not chosen a plan" — either the PAYG row *is* the default
   (retire `ai_margin_percent`, make `accountMarginBasisPoints` fall back
   to the PAYG row) or the global setting is what PAYG means (seed the
   row from it). Then re-derive §0.1 from whichever baseline is chosen,
   because the ladder's whole argument is the spacing between its rungs.
6. **Plan changes mid-period are not what §3.6 says.** `setAccountPlan`
   swaps `plan_code` in place: the new margin and entitlements apply
   immediately, the current period keeps the old price, the new price
   starts at the next rollover, nothing is prorated and nothing is
   reversed. Upgrade = the higher tier free until rollover; downgrade =
   the lower margin immediately while still owing the higher fee. Also:
   subscribe and cancel before 04:20 and no period is ever opened, so a
   day of Studio costs nothing (moot while self-serve is off; not moot
   after). **Fix:** decide the simple rule and implement it in one place —
   proposal: a downgrade takes effect at the next period (`cancel_at`
   semantics with a target plan), an upgrade is §3.6's reverse-and-rebook
   (refund the unearned remainder, open a period at the new price from
   now). Test both.
7. **"Absorbed surfaces" exists in three places and they disagree.**
   `absorbedSurfaces` in metering.ts is `["scene_convert"]`;
   `checkDailyCapRespected` hardcodes `surface is distinct from
   'scene_convert'` in SQL; `/account/ai` has its own `freeSurfaces` with
   `store_classify` and `store_recategorize` added — and those two are
   *not* absorbed in the ledger. Store classification is metered to the
   publisher's account on the shared key, so publishing scenes spends
   the publisher's $10/day cap on a model call they did not ask for, and
   the moment a `platform` credential reaches `store-publish.ts` it
   becomes a line on their bill while their page says "free". **Fix:** one
   exported list; add the two store surfaces to it (the classifier is our
   moderation cost, the same argument as the converter); integrity.ts
   takes the list as a parameter; the page imports it. This is the second
   copy-paste in integrity.ts — the whole chargeable expression is
   duplicated from account-usage.ts there, the thing that file's header
   says must not happen. Export the SQL fragment and reuse it.
8. **`/admin/billing` says "All checks pass" without running the cap
   check.** The page calls `checkLedgerIntegrity(db, { overdraftMicros })`
   and never passes `dailyCapMicros`, so invariant 5 silently returns
   nothing there; only the nightly job runs it. The settings form on the
   same page has margin, overdraft and mode but no daily-cap field, though
   §5.3 says the cap is "a superadmin edit rather than a deploy". Fix both.
9. **The SPA does not know the new refusals.** `SceneAiPanel` handles
   `missing_api_key` only; `daily_cap_reached` (402) and `ai_disabled`
   (403) fall through to the generic error, in both the cloud components
   and the shared frontend. §5.3 claims they render as their own state.
   Three call sites (scene chat, new-scene chat, app chat) need the two
   states, with the reset time and the link to the switch.
10. **`checkDailyCapRespected` scans all of history every night, against
    today's cap.** It has no date bound, so it grows linearly forever and
    re-judges last year by this year's setting. Window it (the last 7 days
    is plenty; the point is to catch a missing gate, not to audit history)
    and, if the cap ever changes, snapshot the cap into the record's
    pricing the way the margin already is.
11. **Two definitions of "what you owe", and only one of them is the
    invoice.** The page, the header row and the cap all read
    `ai_usage_records`; the receivable in the ledger is what the month-end
    run will collect. They agree only while nothing but metered turns
    exists. A reversal of an `ai_usage_charge` leaves the record untouched
    (the page still shows it, the cap still counts it); a promo grant, a
    subscription charge, a refund to receivable, a write-off — none of them
    reach the page. Under postpay the receivable *is* the bill (§3.2), so
    before the first invoice the account page has to show the receivable
    balance (with the subscription fee and any credits as lines), and the
    usage table is the breakdown beneath it, not the total. Metering rows
    that were reversed need a mark (`credited_at`, or a join to the
    reversal) so they stop counting against the cap.
12. **The lifecycle golden file walks the model the doc rejects.**
    `lifecycle.integration.test.ts` books a prepaid purchase and a promo
    grant into `liability:credits*`, then meters turns against the
    *receivable* — the same customer both owes us and is owed by us,
    which is exactly "two models in one book" (§7 Phase 3b). §6 also
    claims a postpay walk through invoice → payment → fee, and those
    recipes do not exist yet. Split it: a shelf walk for §3.5 (purchase →
    spend at rule v1 → refund) that only proves the shelved recipes still
    compile, and the postpay walk that grows as 3b lands.
13. **Invariant 2 is invariant 1 restated.** `checkAccountingEquation` sums
    debits and credits across the book, which is guaranteed by every entry
    balancing. The equation worth checking is *by type*: assets −
    liabilities − equity − revenue + contra + expenses = 0 with each
    account signed by its normal side — that is the check that catches an
    account seeded with the wrong `normal_side`, which nothing catches
    today.
14. **Invariant 4's "pending events" half is dead code.** The kernel
    inserts the event and stamps `processed_at` in the same transaction,
    so an unstamped event cannot be observed after commit;
    `findUnpostedEvents` and `financial_events_pending_idx` guard a state
    that cannot exist. Either delete them or keep them and say in the code
    that they are a tripwire for a future second writer — not "the
    sweep's queue", which they are not (the sweep's queue is
    `ai_usage_records`).
15. **`dailySummary` calls every expense "provider cost".** It sums
    `a.type = 'expense'`, so the moment `psp_fee` or `receivable_writeoff`
    posts, the admin tile labelled "Provider cost" and the margin beside
    it include fees and bad debt. Sum the `cost_of_revenue` group, or the
    COGS account, and give fees and write-offs their own lines. (The same
    function reads `ledger_balances` for the two customer totals while the
    file's header says nothing in it reads the cache — the header is wrong
    by one function, and it is fine that it does, but say so.)
16. **Frame count still ignores the plan.** `accountLimits()` carries
    `frames`, but `enroll` and `claim-tokens` read `maxFramesPerAccount`
    directly. Harmless while every plan says 50; false as a claim (§7
    Phase 5 says every enforcement point moved) and a trap the first time
    a plan row changes the number.
17. **An unknown model prices at 2.5× silently.** `resolveModelPrice`
    falls back to the "unknown" row ($5/$0.5/$30) for any model id not in
    the table — a dated snapshot id, a rename, a new tier — and the only
    trace is `priceSource: "fallback"` inside the pricing jsonb. That is
    the right direction to err in and the wrong way to find out. Add a
    nightly check: any record in the last day with `priceSource <>
    'table'` is a violation. And the price table has no admin editor and
    duplicates `fallbackModelPrices` in code: a provider price change is a
    SQL insert nobody is reminded to make, in two places.
18. **The sweep is bounded at 500 rows a night** and stops there; a
    backlog larger than a night's limit never drains. Loop until the
    scan comes back empty, or at least alert when `scanned == limit`.

### 9.3 Design changes to make before Phase 3b, in order

- [x] Fix §9.2 items 1–4 and 7–9 first; they are bugs with tests missing,
      not decisions. Items 5 and 6 are decisions and small code; 11 is
      the biggest piece of new work and gates the first invoice. *Done in
      PR #432 (§9.5).* The rest of this list: 2026-09-02, §9.6.
- [x] **Run the Phase 2 gate.** (Scripted and run 2026-09-02, §9.6 — the
      meter agrees with PostHog on everything there was to compare, and
      there was one day of it; the provider side needs an admin key nobody
      has put in an env yet.) It has been open since 2026-08-31 and is
      the only thing that would tell us the meter is right: a week of
      `ai_usage_records` against PostHog `$ai_generation` sums (turn count
      and token totals) *and* against OpenAI's usage export (§8.2 settles
      there). It is one query on each side and it has not been run. Write
      it as a script so it can be re-run on the next model change.
- [ ] **Which legal entity invoices, and from where.** *Written up as
      §8.15 with the questions in order — the answer is the owner's.* Not in this
      document anywhere, and prior to the provider choice: the entity on
      the invoice, its VAT registration, whether it must number invoices
      sequentially by law (many EU jurisdictions require gapless
      sequences — `invoices.number` is designed for that but nothing
      assigns it), and whether B2C sales to other EU countries trigger
      OSS. §8.6/§8.7 assume this is answered.
- [x] **Subscriptions are billed in advance**, which is normal SaaS and
      not stored value, but §0's "we invoice for a service already
      rendered" is only true of metered usage. Say so in §0 and in the
      invoice copy; the ledger already treats it correctly (deferred
      until recognised).
- [x] **Subscription revenue is recognised only at period end**, so a
      calendar-month P&L lags by up to a month. Fine at this size; either
      say so in §3.6 or recognise daily from the nightly job (one more
      idempotent step per period, `recognized_micros` on the row).
- [x] **The cap counts shared-key usage** at the customer's margin. That
      bounds our exposure, which is its job, but a free-tier user is then
      "limited" on money they do not owe and the page shows them a dollar
      figure with "nothing is billed" under it. Either the message for
      shared-key refusals says "the operator's daily allowance", or the
      shared key gets its own smaller cap — it is our money either way.
- [x] **Operator surfaces are missing.** §5.1's superadmin view of the AI
      switch, and any way to put an account on a plan other than psql
      ("an operator moves accounts by hand" has no route). Both are small
      admin routes plus audit events; both are needed before 3b's dunning
      step, which ends by throwing the switch.
- [x] **The nightly job runs as one person's API token.** If that
      superadmin revokes the token or is removed, the job dies; the
      healthchecks ping is optional in the env example. Make the ping
      mandatory on the production box (verify it is set), and consider a
      dedicated service account for the token.
- [x] Phase 3b's `invoices` migration is **0048**, not 0045 — Phase 5 took
      that number, the §9 fixes 0046, daily recognition 0047.

### 9.4 Where this document said something the code did not do

Corrected in place above on 2026-09-02; the list is kept so the next
reader knows which sentences to distrust when the two drift again:

- §2.1 / §7 Phase 6: "a schema test fails if one ever does" — only for
  the 0042 tables; 0043 and 0045 tables are not in the test, and 0045 has
  a cascading FK (§9.2 item 4).
- §5.1 "Superadmin side" — not built. §5.3 "a per-account override
  column" — does not exist. §5.3 "rendered by the SPA's AI panel as its
  own state" — not built (item 9).
- §5.2's wire shape — the real `ai` block is `{billable_micros,
  daily_cap_micros, enabled, margin_basis_points, metering_mode,
  month_micros, own_key_only, previous_month_micros, today_micros,
  turns_this_month}`; there is no `credential_source` or
  `month_cost_micros`.
- §6 golden files — the live one is still the prepaid walk (item 12).
- §7 Phase 2: "walks a customer from purchase through usage" describes
  the prepaid model; §7 Phase 5: "every enforcement point moved onto
  `accountLimits`" — frames did not (item 16).
- §4 reports.ts "never `ledger_balances`" — `dailySummary` does (item 15).
- `docs/todo.md` still lists "Billing mechanics — Stripe?" and "free cloud
  rendering forever" as open; §0.2 here decided the second and this
  document is the first. Updated 2026-09-02.

### 9.5 What the fix did — 2026-09-02, migration 0046

Every §9.2 item, with the decision where one had to be made:

1. **Surface** — the chat route meters the literal `scene_chat`; the
   client's hint is `ai_usage_records.context` and nothing prices on it.
   0046 rewrites the shadow rows that carried the hint as their surface.
   Test: a chat sent with `surface: "scene_convert"` meters as
   `scene_chat`.
2. **Gap billing** — periods never start before `started_at`, and a return
   after a cancellation resets it. Test: cancel, 200 days, return → one
   period.
3. **Cap** — the gate refuses at `cap`; a running turn is stopped at
   `cap + overdraft` by a per-round budget check in the chat route; the
   nightly check tolerates `cap + overdraft`. Concurrent turns can still
   each overshoot; accepted as a rare alert at today's volume rather than
   an in-flight reservation.
4. **Cascade** — `subscriptions.account_id` is a plain uuid; the schema test
   covers every billing table; both account-deletion routes call
   `closeOutSubscriptionForDeletedAccount` first (refund the unearned
   remainder, close the period, cancel); invariant 9 watches the account.
5. **Ladder** — *decided:* one number, the plan row's. An account with no
   subscription prices at the PAYG row (100%, the user's figure), and
   `ai_margin_percent` is only the fallback for a deployment with no plan
   rows. Nothing has ever been billed, so this changes shadow-mode display
   numbers and nothing else. The ledger tests pin the PAYG row to 30% so
   their worked examples stay readable; one test asserts the seeded 100%.
6. **Plan changes** — upgrade = prorated refund + close + new period now;
   downgrade = `next_plan_code`, applied at the rollover (a downgrade to
   free at the rollover is a cancellation); the first period is opened and
   charged inside `setAccountPlan`. Both directions have a golden test.
7. **Absorbed surfaces** — one list in `metering.ts`, now including
   `store_classify` and `store_recategorize`; the cap check builds its SQL
   from it; the page imports it. The chargeable SQL is exported from
   `account-usage.ts` and the invariant reuses it.
8. **Admin page** — runs the cap check with the real cap; the settings form
   has the daily-cap field and the margin field is labelled as the
   fallback it now is.
9. **SPA** — `SceneAiPanel` renders `ai_disabled` and `daily_cap_reached`
   (with the reset time) as their own states. The app-chat client in the
   shared frontend shows the route's `detail` text, which is already the
   human sentence.
10. **Cap window** — the nightly check looks at the last 7 days
    (`capWindowDays`).
11. **One number owed** — the receivable is shown on `/account/ai` ("Your
    balance") with the non-turn statement lines under it; a reversed charge
    stamps `credited_at` on its usage record (`markUsageRecordsCredited`,
    called by the admin reversal route) and the page and cap stop counting
    it. Still open: the page's "this month" figure is the metered usage,
    not the receivable — deliberately, because in shadow mode the
    receivable is zero and the usage is the honest number.
12. **Golden files** — split into the postpay walk (turns → reversal +
    credit → reclassification) and the prepaid shelf walk (manual journals
    only).
13. **Invariant 2** — by type, plus a check that every account's
    `normal_side` matches its type.
14. **Pending events** — kept, relabelled a tripwire in the kernel.
15. **Daily summary** — COGS is `expense:cogs:*`; fees and bad debt are
    their own fields and show beneath the margin tile.
16. **Frame count** — enroll and claim-tokens read
    `accountLimits().frames`.
17. **Unknown model** — invariant 10. No admin price editor yet (§9.3).
18. **Sweep** — loops in batches until the queue is empty or a batch posts
    nothing.

Not done here, still §9.3: the Phase 2 comparison against PostHog and the
provider invoice, the legal-entity/VAT question, the operator surfaces for
the switch and for plans, the service account for the nightly token, and
`docs/todo.md`'s two stale lines.

### 9.6 What the pre-3b pass did — 2026-09-02, migration 0047

Every §9.3 item, with the decision where one had to be made:

1. **The Phase 2 gate, run.** `apps/auth-web/scripts/ai-metering-compare.mjs`
   compares `ai_usage_records` with PostHog `$ai_generation` (and
   `scene_convert`) and with OpenAI's usage/costs API, per UTC day and
   model. What production had to compare on 2026-09-02: metering went
   live at 22:27 UTC on 2026-08-31, so there was **one full day**, not a
   week. On it the meter and PostHog agree **exactly** — 2026-09-01,
   gpt-5.6-terra: 7 turns / 18 rounds, 302,723 input (218,110 cached),
   11,488 output, 986 reasoning on both sides — and the five metered scene
   conversions match PostHog token-for-token by request id. What is still
   unproven is the provider's invoice: the script's OpenAI side needs an
   *organisation admin* key (`OPENAI_ADMIN_KEY`) that nobody has put in an
   env yet, and §8.2 (reasoning billed as output) is settled only there.
   **Re-run the script over a real week before flipping metering to live**;
   the meter-vs-PostHog half is not in doubt any more, the meter-vs-invoice
   half has not been looked at.
2. **Invoicing entity** — written up as §8.15 in decision order (entity,
   VAT position, gapless numbering, OSS, reverse charge). Not decided; it
   cannot be from here.
3. **Subscriptions billed in advance** — §0 says so now, `/account/ai` says
   so on the plan line, and 3b's copy item carries it.
4. **Daily recognition** — built, not merely documented (§3.6):
   `subscription_periods.recognized_micros` (0047) is the cursor, the
   nightly cycle gained an accrual step between charging and close-out,
   `earnedToDateMicros` is whole-days pro rata of `price − refunded`, and
   a refund is bounded by what is still deferred after accruals. The
   deferred-revenue invariant subtracts `recognized_micros`. Tests: the
   day-by-day walk (10 days → 641,935 of a Maker month; nothing twice for
   the same day; the close-out books the remainder on the period's last
   day, not the night the job ran) and a refund after accruals.
5. **Shared-key cap** — *decided: both.* Its own
   `shared_key_daily_cap_micros` (falls back to the main cap until set,
   so nothing changes on its own) AND the refusal names whose allowance
   it was: `allowance: "shared" | "billable"` on the 402, the panel and
   `/account/ai` word it as the operator's allowance, and the nightly
   check judges shared-only account-days against the shared ceiling.
6. **Operator surfaces** — `PUT /api/admin/billing/customers/<id>/ai` and
   `…/plan`, both reason-required and audited (`admin.ai_disabled`,
   `admin.ai_enabled`, `admin.plan_changed`, `admin.plan_canceled`), on the
   customer statement page, which also now leads with the receivable and
   hides the prepaid shelf statements unless something posted to them.
7. **Nightly job identity** — `scripts/accounting-service-account.sh`
   mints the token on a dedicated account with no login identity (psql
   only, so it runs on the box; hash and hint match `api-tokens.ts`). Since
   the 2026-09 security pass it is a job token (`fc_apijob_…`,
   `billing_nightly`) that opens only the nightly route, and the account is
   no longer a superadmin; the healthchecks ping is **required** (`none` opts
   out on purpose) and `install.sh` refuses to arm the timer on
   placeholders. Found while verifying: **the job had never been
   installed on production** — no env file, no timer. Installed the same
   day: token minted on the box for `accounting-job@frameos.net`, a
   healthchecks check, timer at 04:20 UTC; the first run passed with no
   violations.
8. **Numbers** — 3b's `invoices` migration is 0048.

Also in this round: `docs/todo.md`'s two stale lines now point here.

