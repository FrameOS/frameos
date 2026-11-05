-- The payment provider half of the plans (cloud/docs/billing.md,
-- cloud/docs/accounting-todo.md Phase 3b). The provider is Creem, a
-- merchant of record: it sells the plan, charges the card, handles tax and
-- pays us out. These four tables are what we know about its side.
--
-- Like every billing table they reference nothing outside the accounting
-- module (§2.1): account ids are plain uuids, so deleting an account cannot
-- cascade a payment away.
--
-- Every row names its `mode`. A test-mode purchase on the production
-- database (the wiring check before go-live) must never be mistaken for
-- money, and never posts to the ledger.

-- Who drives this subscription's periods. NULL: the ledger's own nightly
-- cycle, charging the receivable (an operator-set plan). 'creem': a period
-- opens when the provider reports a payment, with the provider's bounds.
ALTER TABLE "subscriptions" ADD COLUMN "provider" text;

-- Plan code to the provider's product, per mode. A price change makes a new
-- product, so a plan can have several rows; `active` is the one a new
-- checkout uses. Subscriptions on an older product still resolve.
CREATE TABLE "provider_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" text NOT NULL,
  "mode" text NOT NULL CHECK ("mode" IN ('test', 'live')),
  "plan_code" text NOT NULL,
  "product_id" text NOT NULL,
  "price_micros" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "provider_products_product_unique"
  ON "provider_products" ("provider", "mode", "product_id");
CREATE INDEX "provider_products_plan_idx"
  ON "provider_products" ("provider", "mode", "plan_code");

-- The provider's subscription for an account, as last seen (a webhook, the
-- return from checkout, or the nightly reconcile). The plan an account is
-- entitled to is still `subscriptions`; this is the collector's view.
CREATE TABLE "provider_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" text NOT NULL,
  "mode" text NOT NULL CHECK ("mode" IN ('test', 'live')),
  "account_id" uuid NOT NULL,
  "customer_id" text,
  "subscription_id" text NOT NULL,
  "product_id" text,
  "plan_code" text,
  "status" text NOT NULL,
  "current_period_start" timestamptz,
  "current_period_end" timestamptz,
  "canceled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "provider_subscriptions_subscription_unique"
  ON "provider_subscriptions" ("provider", "mode", "subscription_id");
CREATE INDEX "provider_subscriptions_account_idx"
  ON "provider_subscriptions" ("account_id");

-- Every webhook delivery, once. The provider's event id is the idempotency
-- key: a retry finds the row and is acknowledged without being applied
-- twice. `payload` is stored without the customer's name and email.
CREATE TABLE "provider_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" text NOT NULL,
  "mode" text NOT NULL CHECK ("mode" IN ('test', 'live')),
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "account_id" uuid,
  "subscription_id" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "error" text
);
CREATE UNIQUE INDEX "provider_events_event_unique"
  ON "provider_events" ("provider", "event_id");
CREATE INDEX "provider_events_received_idx"
  ON "provider_events" ("received_at");

-- Money the provider collected or handed back, once per provider
-- transaction. `amount_micros` is net of tax (the tax is the provider's to
-- remit); `period_id` is the subscription period the payment bought.
CREATE TABLE "provider_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" text NOT NULL,
  "mode" text NOT NULL CHECK ("mode" IN ('test', 'live')),
  "kind" text NOT NULL CHECK ("kind" IN ('payment', 'refund')),
  "transaction_id" text NOT NULL,
  "account_id" uuid NOT NULL,
  "subscription_id" text,
  "plan_code" text,
  "amount_micros" bigint NOT NULL CHECK ("amount_micros" >= 0),
  "tax_micros" bigint NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'USD',
  "period_id" uuid,
  -- False for a test-mode payment: recorded, never posted.
  "posted" boolean NOT NULL DEFAULT true,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "provider_payments_transaction_unique"
  ON "provider_payments" ("provider", "mode", "kind", "transaction_id");
CREATE INDEX "provider_payments_account_idx"
  ON "provider_payments" ("account_id", "occurred_at");
