# FrameOS Cloud accounting module — design + todo

Status: written 2026-08-31. Phases 0 and 1 are built (migration 0042,
`cloud/packages/ledger`); nothing meters or charges yet — that starts at
Phase 2.

The goal: real double-entry accounting inside FrameOS Cloud. Users buy prepaid
credits, we meter their AI spend (gpt-5.6-terra today), add a configurable
margin (~30%), and every cent is traceable through an immutable ledger. The
same ledger must carry subscriptions, prepaid-credit-pays-for-subscription,
partial-period refunds (modelled now, implemented later), postpay, and —
eventually — bank/PSP reconciliation against real revenue.

The first shippable product is a **pay-as-you-go plan for AI credits**:
accounts without their own OpenAI key buy credits and burn them per turn.

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
product code (chat route, Stripe webhook, admin action, cron)
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
- "Credits" are **not a separate commodity** — a customer's credit balance is
  simply the balance of their liability account, denominated in USD.
  Display can say "1 credit = $0.01" but the ledger only knows dollars.
  (Promotional/gift credits get their own liability account, §3.6, because
  they are not deferred revenue.)

### 1.2 Chart of accounts

`ledger_accounts` holds both **system accounts** (one row each) and
**per-customer subaccounts** (created lazily, `owner_account_id` set). The
account `code` is the stable programmatic handle.

Launch chart (system accounts):

| code | type | normal side | purpose |
|---|---|---|---|
| `asset:psp:stripe` | asset | debit | money sitting at Stripe (charges land here, fees and payouts leave) |
| `asset:bank:main` | asset | debit | our bank account (used once payouts/reconciliation arrive) |
| `asset:receivable:customer:<id>` | asset | debit | postpay, later — what a customer owes us |
| `liability:credits:customer:<id>` | liability | credit | **prepaid credit balance** (deferred revenue held per customer) |
| `liability:credits_promo:customer:<id>` | liability | credit | granted/promo credits (not money we owe back) |
| `liability:deferred:subscriptions` | liability | credit | subscription fees collected but not yet earned |
| `liability:refunds_payable` | liability | credit | refunds approved but not yet sent |
| `liability:accrued:openai` | liability | credit | provider cost incurred, invoice not yet paid |
| `revenue:ai_usage` | revenue | credit | recognized PAYG revenue |
| `revenue:subscriptions` | revenue | credit | recognized subscription revenue |
| `contra_revenue:promo` | contra-revenue | debit | cost of granting promo credits |
| `expense:cogs:openai` | expense | debit | provider cost of metered usage |
| `expense:psp_fees` | expense | debit | Stripe fees |

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
   links to it via `reverses_entry_id` / `metadata.reclassifies`.
   Use for: actual mistakes or genuine changes in the nature of an amount.

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
  "source" text NOT NULL,              -- 'chat_route' | 'stripe_webhook' | 'admin' | 'cron' | 'backfill'
  "source_ref" text,                   -- turn id, stripe event id, ...
  "idempotency_key" text NOT NULL,     -- the dedupe handle, e.g. 'stripe:evt_...' or 'turn:<uuid>'
  "occurred_at" timestamptz NOT NULL,  -- economic time (when the tokens were burned)
  "payload" jsonb NOT NULL,            -- full fact: token counts, stripe object, ...
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
  "external_ref" text,                 -- stripe charge/balance_txn/payout id — reconciliation hook
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
-- Phase 2: high-volume metering subledger (one row per AI turn; per-round detail in payload)
CREATE TABLE "ai_usage_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid,                   -- accounts uuid, no foreign key (§2.1)
  "chat_id" uuid,
  "turn_id" uuid NOT NULL,
  "surface" text,                      -- 'scene_chat' | 'app_chat' | 'scene_convert' | ...
  "model" text NOT NULL,
  "credential_source" text NOT NULL,   -- 'account' | 'shared' | 'platform'
  "input_tokens" integer NOT NULL,
  "cached_input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "reasoning_tokens" integer NOT NULL,
  "rounds" integer NOT NULL,
  "cost_micros" bigint NOT NULL,       -- provider cost at snapshot prices
  "price_micros" bigint NOT NULL,      -- customer price = cost × (1 + margin), 0 when not billable
  "pricing" jsonb NOT NULL,            -- {unit prices, margin, price table version}
  "event_id" uuid REFERENCES "financial_events"("id"),  -- NULL until posted
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ai_usage_records_turn_unique" ON "ai_usage_records" ("turn_id");
CREATE INDEX "ai_usage_records_account_created_idx" ON "ai_usage_records" ("account_id", "created_at");

-- Phase 2: effective-dated provider price table (admin-editable, auditable)
CREATE TABLE "ai_model_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "model" text NOT NULL,
  "input_micros_per_token" bigint NOT NULL,
  "cached_input_micros_per_token" bigint NOT NULL,
  "output_micros_per_token" bigint NOT NULL,   -- reasoning tokens bill as output
  "effective_from" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ai_model_prices_model_from_unique" ON "ai_model_prices" ("model", "effective_from");

-- Phase 2: first global settings table (margin etc.); admin-writable, audited
CREATE TABLE "billing_settings" (
  "key" text PRIMARY KEY,              -- 'ai_margin_percent', 'payg_overdraft_micros', ...
  "value" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid                    -- accounts uuid, no foreign key (§2.1)
);

-- Phase 3: Stripe purchase intents (state machine; the ledger only sees success events)
CREATE TABLE "credit_purchases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid,                   -- accounts uuid, no foreign key (§2.1)
  "amount_micros" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "status" text NOT NULL,              -- 'pending'|'succeeded'|'failed'|'refunded'
  "stripe_checkout_session_id" text,
  "stripe_payment_intent_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "credit_purchases_checkout_unique" ON "credit_purchases" ("stripe_checkout_session_id");

-- Phase 5: plans + subscriptions (sketch; refine in that phase)
CREATE TABLE "billing_plans" ( ... );          -- code, name, price_micros, period ('month'), features jsonb, active
CREATE TABLE "subscriptions" ( ... );          -- account_id, plan, status, started_at, cancel_at, payment method (credits|stripe)
CREATE TABLE "subscription_periods" ( ... );   -- subscription_id, period_start/end, charged entry, recognition state
```

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
  metered turn posts two entries, and while the customer charge carries a
  `liability:credits:customer:<uuid>` leg that keeps it attributable through
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
examples with a $10 purchase, 30% margin, terra prices.

### 3.1 Credit purchase (Phase 3)

Stripe checkout for $10 succeeds (webhook `checkout.session.completed`):

```
Entry 'credit_purchase'         (external_ref: stripe payment_intent)
  Dr asset:psp:stripe                       10.000000
  Cr liability:credits:customer:<id>        10.000000
```

Stripe fee, booked from the `balance_transaction` (same webhook or the
charge.updated that carries it):

```
Entry 'psp_fee'                 (external_ref: stripe balance_txn)
  Dr expense:psp_fees                        0.590000
  Cr asset:psp:stripe                        0.590000
```

The customer's balance is the full $10 — the fee is our cost, not theirs.

### 3.2 AI usage (Phase 2/3) — the PAYG core

A turn on the platform key burns 40k input + 12k cached + 30k output tokens:
cost = 40k×2 + 12k×0.2 + 30k×12 = 442,400 µ$ (~$0.44). Price at 30% margin
= 575,120 µ$. Two *independent* leg pairs from one event:

```
Entry 'ai_usage_charge'         (metadata: tokens, unit prices, margin=0.30)
  Dr liability:credits:customer:<id>         0.575120
  Cr revenue:ai_usage                        0.575120

Entry 'ai_usage_cost'
  Dr expense:cogs:openai                     0.442400
  Cr liability:accrued:openai                0.442400
```

Revenue is recognized immediately — for metered usage, service-rendered time
*is* usage time (this is what makes PAYG accounting clean). The accrued
OpenAI liability is settled when we actually pay the invoice
(`Dr liability:accrued:openai / Cr asset:bank:main`), and the drift between
accrual and invoice is exactly what reconciliation will measure later.

Usage on the customer's **own** OpenAI key produces a usage record with
`price_micros = 0` and *no* charge entry (they pay OpenAI directly) and no
cost entry (we incurred nothing). We still keep the record for analytics.

### 3.3 Subscription charged from prepaid credits (Phase 5)

Monthly plan $5, paid from credit balance — Airbnb's "virtual movement", no
real money moves:

```
Entry 'subscription_charge_from_credits'
  Dr liability:credits:customer:<id>         5.000000
  Cr liability:deferred:subscriptions        5.000000
```

Then recognition over the period (single entry at period end, or daily —
decision in Phase 5):

```
Entry 'subscription_recognition'   (occurred_at: period end / each day)
  Dr liability:deferred:subscriptions        5.000000
  Cr revenue:subscriptions                   5.000000
```

A subscription charged by card instead posts
`Dr asset:psp:stripe / Cr liability:deferred:subscriptions` — same shape,
different first leg. Because recognition is separate from charging, the
unearned remainder of any period is *always* sitting in
`liability:deferred:subscriptions`, which is what makes §3.4 possible.

### 3.4 Mid-period refund of unused subscription (modelled, NOT implemented)

Cancel halfway with $2.50 unrecognized:

```
Entry 'subscription_refund_to_credits'   (reverses remaining deferral)
  Dr liability:deferred:subscriptions        2.500000
  Cr liability:credits:customer:<id>         2.500000
```

or, cash refund path:

```
Entry 'subscription_refund_approved'
  Dr liability:deferred:subscriptions        2.500000
  Cr liability:refunds_payable               2.500000
Entry 'refund_paid'              (external_ref: stripe refund id)
  Dr liability:refunds_payable               2.500000
  Cr asset:psp:stripe                        2.500000
```

Nothing new is needed in the schema for this — only the recipes and a
product surface. That is the "make it possible" requirement satisfied.

### 3.5 Corrections and alterations

Never edit. Post `Entry X-reversal` (`reverses_entry_id = X`, every leg
mirrored) and then, if needed, a fresh correct entry. Full
reverse-and-rebook, not deltas — Airbnb's lesson: deltas compound into
unauditability.

### 3.6 Promo / granted credits (Phase 4+, cheap to include early)

```
Entry 'promo_grant'
  Dr contra_revenue:promo                    5.000000
  Cr liability:credits_promo:customer:<id>   5.000000
```

Usage draws promo balance before (decision: or after) paid balance; the
charge entry debits the promo account but still credits `revenue:ai_usage`
at full price — the grant's contra-revenue already nets it out. Promo
credits are excluded from any future refund math, which is why they must not
share the paid-credits account.

### 3.7 Postpay (later)

Same usage recipes with the first leg swapped:
`Dr asset:receivable:customer:<id> / Cr revenue:ai_usage`, then invoice
settlement clears the receivable. The chart already has the account; no
model change.

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
  lazy creation (customer subaccounts on first touch).
- `src/pricing.ts` — price lookup (`ai_model_prices` effective-dated, with a
  hardcoded fallback seeded from `evals/compare-models.ts` values), margin
  from `billing_settings`, cost/price computation with the single-rounding
  rule.
- `src/balances.ts` — `accountBalanceMicros(db, code)` off the cache,
  `accountBalanceFromPostings` for the slow always-correct answer, and
  `availableCreditMicros(db, accountId, {overdraftMicros})` (paid + promo +
  whatever overdraft policy allows) for the Phase 3 spend gate.
- `src/money.ts` — the one door micro-dollar amounts come through: jsonb
  payloads carry them as decimal strings, because JSON's single number type
  silently loses integers above 2^53.
- `src/integrity.ts` — the invariant checks (§6), callable from tests and
  the nightly script.

`apps/auth-web/src/lib/billing.ts` wraps the package for route use (session
scoping, wire payloads — snake_case JSON per house rule).

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

- **Payer signal exists and is discarded**: `resolveAiCredentials()` in
  `apps/auth-web/src/lib/ai/api-key.ts` returns
  `source: "account" | "shared"`; the chat route drops it. Add
  `source: "platform"` (PAYG on our key, billed) and thread `source` through
  to the usage record. Billing rule: `account` → record only;
  `shared` → record only (operator's free tier); `platform` → charge.
- **Commit points**: `startTurn()`'s `onFinish` in
  `apps/auth-web/src/lib/ai/turn-runner.ts` (per turn; `onRound` deposits
  per-round detail). `usageSeen` accumulation already exists in
  `app/api/ai/chat/route.ts`.
- **`turnId` is in-memory only today** — it becomes the usage-record key, so
  it must be persisted (it already reaches PostHog as `$ai_trace_id`).
- **Other OpenAI call sites needing meters**: app-code chat
  (`src/lib/ai/app-chat.ts` — currently no telemetry at all and reads the
  account key directly; route through `resolveAiCredentials`), scene convert
  (`app/api/scenes/convert/route.ts` — its per-IP/day rate-limit budget gets
  replaced by real billing for logged-in platform users), moderation +
  admin recategorize (operator-paid, record with `price_micros = 0`).
- **Spend gate**: before starting a platform-key turn, require
  `availableCreditMicros > 0` (allow the configured overdraft to cover the
  in-flight turn; a turn's cost is unknown until it ends). Error shape:
  `jsonError("insufficient_credits", 402)` with balance in the body.
- **Surfacing**: extend `GET /api/account/usage` (already the aggregation
  point that MCP `account_quota` proxies) with
  `credit_balance_micros`, `promo_balance_micros`, spend this month.
- **Margin config**: no global settings surface exists today.
  `billing_settings` (+ admin form, superadmin-gated via
  `getSuperadminContext()`, written through `recordAuditEvent`) is the first
  one; env-var fallback `FRAMEOS_CLOUD_AI_MARGIN_PERCENT` (default 30,
  parsed `usage.ts`-style with `logWarn`) for bootstrap.
- **Jobs**: no runner exists; nightly integrity + unposted-sweep is a new
  `scripts/accounting-nightly.sh` (tsx) + `ops/` systemd timer, sibling of
  `db-cleanup` / the backup timers.

---

## 6. Invariants (the smoke-test suite)

Each is (a) a vitest integration test and (b) a nightly checker query that
alerts (`reportError`) on violation:

1. **Every entry balances**: per `entry_id` per currency,
   SUM(debit amounts) = SUM(credit amounts).
2. **Accounting equation**: SUM over all postings, signed by account
   `normal_side`, per type: assets = liabilities + equity + (revenue −
   contra − expenses). Globally: total debits = total credits.
3. **Cache is honest**: `ledger_balances` = SUM(postings) per account,
   exactly.
4. **Events post exactly once**: no `processed_at IS NULL` older than N
   minutes; no two entries of the same `entry_type` for one event unless the
   recipe declares multiplicity.
5. **No negative customer credit** beyond the configured overdraft.
6. **Metering completeness**: every `ai_usage_records` row with
   `credential_source = 'platform'` has `event_id` set (after sweep);
   every finished platform-key turn has a usage record (count vs
   `ai.chat.turn_finished` logs / PostHog as an external cross-check).
7. **Reversals mirror**: an entry with `reverses_entry_id` has legs exactly
   negating its target.
8. **Immutability**: the update/delete triggers exist and fire (tested by
   attempting an UPDATE and expecting the exception).

Plus Airbnb-style **golden-file lifecycle tests**: scripted scenarios
(purchase → 3 turns → subscribe from credits → cancel mid-period → refund →
reversal) asserting the full journal and every balance at each step.

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

### Phase 2 — meter AI usage (shadow mode: record everything, charge nothing)
- [ ] Migration `0043`: `ai_usage_records`, `ai_model_prices` (seeded:
      gpt-5.5, gpt-5.6-luna/sol/terra from the eval price table),
      `billing_settings` (seed `ai_margin_percent = 30`).
- [ ] `pricing.ts`: effective-dated lookup, margin, single-rounding
      cost/price computation. Unit tests against hand-computed fixtures.
- [ ] Thread `source` from `resolveAiCredentials` through the chat route;
      write a usage record in `onFinish` (turn-runner, so detached turns
      post too); recipe `ai_usage` (charge entry only for `platform`,
      cost entry for `platform`/`shared`).
- [ ] Wire remaining call sites: app-chat (also fix it to use
      `resolveAiCredentials`), scene-convert, moderation/admin as
      `price_micros = 0` records.
- [ ] Unposted-records sweep function (kernel replay by `turn:<id>` key).
- [ ] Invariant 6 + golden-file test for a metered turn.
- [ ] Run in production in shadow mode; compare a week of
      `ai_usage_records` totals against PostHog `$ai_generation` sums
      before any charging goes live.

### Phase 3 — PAYG credits (first revenue)
- [ ] Stripe account + `stripe` SDK; env plumbing; webhook endpoint
      `app/api/webhooks/stripe/route.ts` (signature check, event id as
      idempotency key, raw-body handling).
- [ ] Migration `0044`: `credit_purchases`.
- [ ] Checkout route (`POST /api/billing/checkout` → Stripe Checkout
      session, fixed top-up amounts to start); success/cancel pages.
- [ ] Recipes: `credit_purchase`, `psp_fee`, `credit_purchase_refund`
      (Stripe-side refund of a purchase — needed for disputes from day one).
- [ ] `source: "platform"` in `resolveAiCredentials` (accounts with
      credit > 0 and no own key), spend gate + overdraft setting,
      `insufficient_credits` error through chat route → SPA panel state.
- [ ] Extend `GET /api/account/usage` + account page: balance, top-up
      button, usage history (from `ai_usage_records`).
- [ ] MCP: extend `account_quota`/`account_info` payloads (route first,
      thin tool after — house pattern).
- [ ] Golden-file test: purchase → turns → balance depletion → gate.
- [ ] Legal/pricing page copy: what a credit is, expiry policy (§8).

### Phase 4 — books you can actually read + ops
- [ ] Admin `/admin/billing`: trial balance by group, journal browser
      (entry → postings → event drill-down), account statement per
      customer, manual journal form (superadmin, audited, reason required).
- [ ] Group management UI (create/re-map — mechanism 1 of §1.3) +
      `reclassification` recipe (mechanism 2).
- [ ] `billing_settings` admin form (margin, overdraft), audited.
- [ ] `scripts/accounting-nightly.sh` + `ops/accounting/…timer`: sweep
      unposted records, run all invariants, `reportError` on violation,
      emit a daily summary log line (revenue, COGS, margin, liability).
- [ ] Backfill decision executed: either start books at go-live (recommended
      — no history to fabricate) or `source: 'backfill'` events for the
      shadow-mode period.

### Phase 5 — subscriptions
- [ ] Migration: `billing_plans`, `subscriptions`, `subscription_periods`.
- [ ] Recipes: `subscription_charge_from_credits`,
      `subscription_charge_card`, `subscription_recognition`.
- [ ] Period lifecycle in the nightly job (charge at rollover, recognize,
      dunning state when balance insufficient — grace period setting).
- [ ] Cancel flow (stop at period end; mid-period refund stays a recipe on
      the shelf per §3.4 until we decide to offer it).
- [ ] Plan UI + entitlement checks where plans gate features.
- [ ] Golden-file: subscribe from credits → recognize → cancel →
      (shelf-test the refund recipe even though no UI calls it).

### Phase 6 — later, enabled by the above, not designed in detail here
- [ ] Bank/PSP reconciliation: import Stripe payout reports + bank
      statements, match on `external_ref`, `reconciliations` table,
      unmatched-items report. (`asset:psp:stripe` vs payout lines is the
      first match target; the accrued-OpenAI account vs their invoices the
      second.)
- [ ] Postpay: credit limits, invoicing, receivables aging.
- [ ] Storage/other metered products: new event types + recipes only.
- [ ] Multi-currency: EUR chart siblings, FX gain/loss account.
- [ ] Refund self-service UI on the §3.4 recipes.

---

## 8. Open decisions (Phase 0)

1. **Credits display unit** — plain dollars, or "credits" at 1 credit =
   $0.01? Ledger is unaffected; pure product copy. Lean: show dollars,
   avoid a fake currency.
2. **Reasoning-token pricing** — the eval table prices output only;
   OpenAI bills reasoning as output tokens. Assumed "reasoning bills as
   output" in §2; verify against the actual invoice line items in shadow
   mode.
3. **Shared-key tier** — once PAYG exists, does
   `FRAMEOS_AI_SHARED_KEY_ACCESS` shrink (e.g. `verified` keeps a small free
   monthly grant as promo credits) or stay as-is? Affects whether promo
   accounts ship in Phase 3 or 4.
4. **Overdraft size** — one turn can cost ~$0.50+; proposal: allow balance
   to go negative by `payg_overdraft_micros` (default $1) and gate the
   *next* turn.
5. **Credit expiry** — legal/VAT implications differ by jurisdiction
   (unused prepaid balances are liabilities indefinitely unless terms say
   otherwise). Needs a terms-of-service answer before launch, not a schema
   change.
6. **VAT/sales tax** — out of scope above, but EU sales likely need it
   sooner than reconciliation does. When it lands: `liability:vat_payable`
   account + tax legs in the purchase/subscription recipes, and Stripe Tax
   can compute the amounts. Flagging now so the recipes are written with a
   third leg in mind.
7. **Stripe vs alternatives** — doc assumes Stripe Checkout (fastest,
   handles SCA); confirm.
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
