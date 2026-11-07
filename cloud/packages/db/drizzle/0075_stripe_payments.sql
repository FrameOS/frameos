-- Stripe as the payment provider (cloud/docs/billing.md).
--
-- Creem, the provider 0073 was written for, is a merchant of record: it
-- sold the plan, kept the tax and remitted it. Stripe is a payment
-- processor: Raaven BV sells the plan, the tax Stripe Tax adds lands in our
-- Stripe balance, and it is owed to the tax authority from the moment it is
-- collected. Stripe also takes its fee out of every charge, where Creem paid
-- out net. So the books gain a liability for the tax and the provider tables
-- learn who remits it and what each fee was.

-- Sales tax (VAT) collected and not yet paid over. Credited by a payment's
-- tax, debited by a refund's (packages/ledger/src/rules/payment.ts).
INSERT INTO "ledger_accounts" ("code", "type", "normal_side", "group_id")
SELECT 'liability:sales_tax', 'liability', 'credit', g."id"
FROM "ledger_account_groups" g
WHERE g."code" = 'liabilities'
ON CONFLICT ("code") DO NOTHING;

-- A fee is money the provider kept: a card payment's processing fee, a
-- dispute's fee. One row per fee, by the provider's id for it.
ALTER TABLE "provider_payments" DROP CONSTRAINT "provider_payments_kind_check";
ALTER TABLE "provider_payments"
  ADD CONSTRAINT "provider_payments_kind_check"
  CHECK ("kind" IN ('payment', 'refund', 'fee'));

-- Who pays `tax_micros` over: the provider (a merchant of record, every row
-- written before this migration) or us.
ALTER TABLE "provider_payments"
  ADD COLUMN "tax_remitted_by" text NOT NULL DEFAULT 'provider'
  CHECK ("tax_remitted_by" IN ('provider', 'us'));

-- The provider's handle on the money (Stripe: the charge). A payment's
-- transaction id is the invoice it paid; a refund and a dispute name the
-- charge, and this is how they find their payment.
ALTER TABLE "provider_payments" ADD COLUMN "payment_ref" text;
CREATE INDEX "provider_payments_payment_ref_idx"
  ON "provider_payments" ("provider", "mode", "payment_ref")
  WHERE "payment_ref" IS NOT NULL;

-- Facts kept for a person: the invoice number, the currency a fee settled
-- in. Never the customer's name, email or address.
ALTER TABLE "provider_payments"
  ADD COLUMN "details" jsonb NOT NULL DEFAULT '{}'::jsonb;
