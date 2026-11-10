# Paid plans and Stripe

The paid plans of FrameOS Cloud are sold through Stripe. Raaven BV is the
seller: Stripe charges the card, Stripe Tax works out and adds the VAT, and
that VAT is ours to pay over. Stripe takes its fee out of every charge.

A Creem adapter (a merchant of record) was built on 2026-11-05 and removed
on 2026-11-07: its account review required its content moderation API on
every prompt that reaches the OpenAI image app, which runs on the
customer's own frame with the customer's own key. That is not ours to
police. Stripe has no such review; the price is that VAT and chargebacks
are ours. The ledger and the provider tables were written provider-neutral
for it and carry over (migration 0073, then 0075 for what a processor that
is not a merchant of record adds: our VAT and its fees).

## What is sold

The catalog is `apps/auth-web/src/lib/plan-catalog.ts`. A group with
`selfServe: true` is bought at checkout: **Private** ($2, $5, $9, $29 a
month) and, since 2026-11-07, **Business** ($49, $99, $199, $499; single
sign-on is on its card as "planned"). Each group is its own product at
Stripe, and one subscription moves between them: Private $29 to Business
$49 is an upgrade like any other. A stop without a price at Stripe (Sync
plans not run since it was added) says "Contact support to activate", and
so does every paid card with Stripe not set up; an operator then moves the
account by hand (`/admin/billing/customers`, after **Sync plans** has
written the `billing_plans` rows).

A plan lists only what exists. `plannedFeatures` and `plannedLimits` in
the catalog name what is not built yet; every page marks those "planned"
and a plan's row does not grant them. Take a name off those lists in the
change that ships the feature.

Prices are US dollars before VAT (`tax_behavior: exclusive`); checkout
adds the VAT of the buyer's country. A business in the EU outside Belgium
that gives its VAT number is invoiced under the reverse charge.

## The rules that are easy to break

- **Stripe owns the clock.** A subscription period exists because Stripe
  reported a paid invoice for it (`applyProviderPayment`,
  `packages/ledger/src/provider-subscriptions.ts`), with the invoice line's
  period. The nightly cycle skips `subscriptions.provider` rows.
- **One function applies Stripe's state:** `applySubscription` in
  `src/lib/billing-provider.ts`. The return from checkout, every webhook
  and the nightly reconcile hand it the subscription as Stripe holds it
  now, and it is idempotent on the invoice id, so they may arrive in any
  order, any number of times.
- **A webhook is a nudge, never the data.** Stripe does not promise order,
  and renders an event in the endpoint's own API version (the CLI and an
  old endpoint send 2023-10-16, whose invoices have no `total_taxes`).
  Every object a notice names (subscription, invoice, refund, dispute) is
  read back from the API in our pinned version, `stripeApiVersion` in
  `src/lib/stripe.ts`.
- **Changes are worked out from the plan paid for** (`subscriptions.plan_code`),
  not Stripe's current price: a downgrade moves Stripe's price at once
  (`proration_behavior: none`) and ours at the renewal, so taking it back
  must charge nothing, and an upgrade is prorated from what was paid
  (Stripe is put back on the paid price first).
- **An upgrade waits for its money.** `proration_behavior: always_invoice`
  with `payment_behavior: pending_if_incomplete`: Stripe invoices the
  difference at once and applies the new price only when it is paid. When
  the bank wants 3-D Secure, the plan route answers 402
  `payment_action_required` with the hosted invoice's URL, and the plan
  cards offer to open it.
- **Test mode never posts to the ledger** (`postsToLedger`;
  `STRIPE_TEST_LEDGER=1` for a development database), and on a production
  build only superadmins can check out in test mode (a test card would be
  a free plan).
- **Live mode opens when told** (`checkoutOpenTo`): until
  `STRIPE_CHECKOUT_OPEN=1`, only superadmins can check out, on any build,
  so the first real payment is made and refunded before the plans are on
  sale. Everyone else sees "Contact support".
- **One currency.** Checkout passes `adaptive_pricing: {enabled: false}`;
  an invoice in another currency than its plan is refused, with the event
  kept for a person.
- **The account is fixed by our checkout**: `frameos_account_id` in the
  session's and the subscription's metadata. A subscription without it was
  sold some other way and is acknowledged and ignored.
- **A plan event is told once, by the write that changed something.**
  `src/lib/plan-notifications.ts` sends the `cloud plan …` PostHog events
  (the reports channel on Discord, through the "Cloud plans" workflow),
  and `billing-provider.ts` calls it only where its own write was the one
  that changed: a payment `applyProviderPayment` applied, Stripe's status
  moved by compare-and-set on `provider_subscriptions`, a downgrade
  `noteProviderNextPlan` recorded, a refund applied, a webhook marked
  processed. A new transition gets its event the same way, never from a
  before-and-after read: the checkout return and three webhooks arrive
  together, and each would see the change.

## What the books get

Micro-dollars. Rules in `packages/ledger/src/rules/payment.ts` (v3) and
`subscription.ts`. Revenue is always net of tax. The VAT goes through the
customer's receivable (v3, 2026-11-07), so their statement on the usage
page reads like the invoice: the plan, the VAT, one payment of both. v2
booked the same balances with the VAT going straight from the Stripe
balance to `liability:sales_tax`, so a statement showed a payment smaller
than the card charge; entries posted before v3 keep that shape (the
journal is append-only).

| Stripe says | Entries |
|---|---|
| Invoice paid, $5 + $1.05 VAT | `Dr receivable / Cr deferred` $5 (the period's charge); `Dr receivable / Cr liability:sales_tax` $1.05 ("VAT or sales tax"); `Dr psp / Cr receivable` $6.05 |
| Its charge's fee, €0.53 at 0.8973 | `Dr expense:psp_fees / Cr psp` $0.590638 (`payment.fee`) |
| Upgrade in the middle of a period | the old period's unearned rest back to the receivable, it closes; the new period is priced at that rest plus what was paid |
| Refund, VAT included | `Dr receivable / Cr psp` all of it; the VAT share `Dr sales_tax / Cr receivable`; the net share out of the deferral first, then revenue |
| Dispute lost | as a refund of the disputed amount |
| Dispute fee (won or lost) | `payment.fee`, at the charge's settlement rate when Stripe gives none |

Stripe keeps its balance in the account's settlement currency (euros for
Raaven BV). A dollar charge's fee arrives in euros with the rate Stripe
converted at, and the books take it at that rate; the original is kept in
the fee row's `details.settlement`. The difference between `asset:psp:main`
and what Stripe pays out (conversion, Stripe Billing's and Stripe Tax's own
monthly fees) is the payout reconciliation's, which is not built.

## Tables

Migration 0073: `provider_products` (plan code to the thing a checkout
sells, per mode: for Stripe the **price** id), `provider_subscriptions`
(Stripe's view), `provider_events` (every webhook once, by event id, with
names, emails, addresses and card details stripped), `provider_payments`
(payments, refunds and, since 0075, fees). Migration 0075 adds
`tax_remitted_by` (`us` for Stripe, `provider` for a merchant of record),
`payment_ref` (the charge, which refunds and disputes name) and `details`
(invoice number, settlement currency). No foreign key leaves the
accounting module; every row names its mode.

## The code

- `src/lib/stripe.ts`: configuration, the SDK client (`stripe` 23.0.1,
  pinned API version), every call the plans make, and what is read out of
  Stripe's objects. Knows nothing of plans or books.
- `src/lib/billing-provider.ts`: the mapping. `syncPlans`, `startCheckout`,
  `applySubscription`, `handleWebhook`, `handleCheckoutReturn`,
  `changePaidPlan`, `cancelAtPeriodEnd`, `portalLink`, `applyRefund`,
  `applyDisputeClosed`, `completePaymentDetails` (charge and fee),
  `reconcileSubscriptions`, `cancelForErasure`.
- Routes: `POST /api/account/plan/checkout`, `GET .../checkout/return`
  (`?session_id=`), `PUT /api/account/plan` (switch, keep, cancel),
  `POST /api/account/plan/portal`, `GET /api/account/plan/invoices` (Stripe's
  list with page and PDF links, refunds from `provider_payments`; not for API
  tokens), `POST /api/webhooks/stripe` (raw body,
  `Stripe-Signature`, 5-minute tolerance, 1 MB cap, 503 when not set up),
  `POST /api/admin/billing/plans` (Sync plans), the nightly job's
  `reconcileSubscriptions`.
- Pages: `/admin/billing/payments` (setup checks, this quarter's money,
  plans, subscriptions, payments, refunds and fees, notices); the usage
  page (`frontend/src/scenes/settings/account/UsagePage.tsx` and
  `plansLogic.ts`): the plan with "Card and billing details" (the portal)
  and "Cancel plan" (at period end, nothing refunded, one confirmation),
  the invoices table, the account statement, the plan cards (prices
  followed by "+ VAT" or "+ tax" from Cloudflare's `CF-IPCountry`, a guess
  for a word only: checkout charges by the billing address); the legal
  pages (Stripe named as the payment processor; `src/lib/legal.ts` lists
  it as an optional processor).
- **Sync plans** writes the `billing_plans` rows and, in Stripe's current
  mode: one product per plan group (found again by its
  `frameos_cloud_group` metadata, tax code `txcd_10103000` for Private,
  `txcd_10103001` for Business), one monthly price per stop under the
  lookup key `frameos-cloud:<plan>:usd:<cents>:month:<tax behaviour>`
  (adopted when another deployment made it, recreated with the key
  transferred when archived), and the customer portal's settings
  (invoices, card, billing details and VAT number, cancel at period end,
  no plan switching). It also reads Stripe Tax's status and the webhook
  endpoint, and says what is missing.
- Account deletion cancels at Stripe first and refuses when it cannot.
- `src/lib/plan-notifications.ts`: the plan events. Which one a paid
  invoice is follows the plan the account was on (`previous` from
  `applyProviderPayment`): none is `cloud plan subscribed`, another plan
  `cloud plan changed`, the same plan `cloud plan renewed` (a
  `subscription_cycle` invoice) or `cloud plan payment received`. Stripe's
  status gives `cancellation scheduled`, `cancellation withdrawn`,
  `payment failed` and `ended` (`statusNoticeFor`), the rest come from
  their own step: `downgrade scheduled`, `refunded`, `dispute opened`,
  `dispute closed`, and `ended` for an account deleted with its plan.
  Each carries `summary` (the Discord line, `[test]` first in test mode),
  `admin_url` (the customer statement) and the money as numbers; nothing
  names the person.

## Environment

| Variable | |
|---|---|
| `STRIPE_SECRET_KEY` | A restricted key (`rk_live_…`) with the permissions below, or a secret key. Unset: nothing can be bought. |
| `STRIPE_WEBHOOK_SECRET` | The endpoint's signing secret, `whsec_…`. |
| `STRIPE_MODE` | `test` (default) or `live`. Must agree with the key's prefix or Stripe stays off. |
| `STRIPE_AUTOMATIC_TAX` | Stripe Tax on checkout and renewals. Default on. |
| `STRIPE_TAX_BEHAVIOR` | `exclusive` (default, VAT on top) or `inclusive`. A change makes new prices at the next Sync plans. |
| `STRIPE_ALLOW_PROMOTION_CODES` | Promotion codes at checkout. Default off. |
| `STRIPE_TEST_LEDGER` | Test payments post to this database's ledger. Development only. |
| `STRIPE_CHECKOUT_OPEN` | Live mode: anyone may check out. Unset: superadmins only. |
| `STRIPE_TEST_OPEN` | Anyone may check out in test mode on a production build. |
| `STRIPE_TEST_CLOCKS` | Test mode: each checkout's customer gets its own test clock, so a renewal can be seen by advancing it. |
| `STRIPE_API_URL` | Test mode: another API host (the integration suite's stand-in). |
| `FRAMEOS_SUPPORT_EMAIL` | The support address in the footer and beside the plan cards. |
| `FRAMEOS_PRICING_URL` | The public price list. Defaults to `https://frameos.net/pricing/`. |

The restricted key: Stripe's "Recurring subscriptions and billing"
template, plus **Tax: Write** (read is enough in production) and, for
`stripe listen` on a laptop only, **Stripe CLI Debugging Tools: Write**.

## Going live

1. **Stripe Tax** (live mode, Settings, Tax): head office address (Raaven
   BV, Leuven), a registration for Belgium (done 2026-11-07 as "Small
   Seller (EU)": Belgian VAT on every EU consumer while EU sales to
   consumers stay under €10,000 a year) and, once they pass it, the EU One
   Stop Shop; registrations for any other
   country where a threshold is passed (the UK, Norway, Switzerland have
   none or low ones for digital services). Without a registration Stripe
   Tax charges nothing there. `/admin/billing/payments` shows the status.
2. **Webhook endpoint** (live mode, Developers, Webhooks):
   `https://cloud.frameos.net/api/webhooks/stripe`, API version
   `2026-09-30.endive` or a later month of the same release (the dashboard
   offers only the latest, `2026-10-28.endive` on 2026-11-07; monthly
   versions only add fields), the events listed on `/admin/billing/payments`
   (`webhookEvents` in `stripe.ts`). Its signing secret is
   `STRIPE_WEBHOOK_SECRET`.
3. **Restricted live key** as above, then `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET` and `STRIPE_MODE=live` in
   `/etc/frameos-cloud/auth-web.env`, then `frameos-cloud-update
   --activate /opt/frameos-cloud` on the box: the live release starts on
   the other instance, reading the env file afresh, with no downtime.
4. **Sync plans** on `/admin/billing/payments` (sudo). It must say
   "8 plans in place at Stripe" and no warning.
5. **Billing settings** in Stripe's dashboard (done 2026-11-07): Smart
   Retries on, and after the last retry **cancel the subscription** (the
   terms promise that the plan ends) and mark the invoice uncollectible
   (nobody pays later for a plan that ended); customer emails for
   successful payments (receipts), refunds, failed payments and expiring
   cards on, linking to Stripe's hosted page; the public business name,
   support email, privacy and terms links and statement descriptor
   (`FRAMEOS`) set.
6. **Settlement currency**: the balance is in euros, so every dollar charge
   is converted (Stripe's conversion fee). Adding a USD settlement
   currency, or pricing in euros, is a decision for the owner.
7. Buy the $2 plan with a real card (as a superadmin: checkout is still
   closed to everyone else), refund it from Stripe's dashboard, and check
   `/admin/billing/payments` and the trial balance.
8. **Open checkout**: `STRIPE_CHECKOUT_OPEN=1` in the env file and
   `--activate` again, then the public price list on frameos.net/pricing.

## Local development and tests

- **Integration suite:** `src/test/stripe-fake.ts` is a stand-in for the
  part of Stripe's API the plans use, served over HTTP so the SDK's real
  requests reach it; it refuses unknown parameters. It is our reading of
  Stripe's docs and of the test-mode run below, not Stripe.
  `src/test/integration/billing-provider.integration.test.ts` drives it.
- **Against Stripe's test mode on a laptop:** a restricted test key in the
  environment, `STRIPE_TEST_CLOCKS=1 STRIPE_TEST_LEDGER=1`, and
  `stripe listen --api-key "$STRIPE_SECRET_KEY" --events <the list>
  --forward-to http://127.0.0.1:3100/api/webhooks/stripe` (its printed
  secret is `STRIPE_WEBHOOK_SECRET`). Use `127.0.0.1` rather than
  `localhost` when the main stack runs on `localhost:3000`: cookies are
  shared across ports. Advance a customer's test clock in Stripe's
  dashboard (or `stripe test_helpers test_clocks advance`) to renew.
  Test cards: 4242 4242 4242 4242 pays, `pm_card_chargeCustomerFail` fails
  later charges, 4000 0027 6000 3184 always asks for 3-D Secure,
  4000 0000 0000 0259 is disputed as fraud.
- **Upgrading the API version:** bump the `stripe` package, take its
  `ApiVersion` into `stripeApiVersion`, read the changelog for the objects
  `stripe.ts` reads (subscription items' periods, invoice `parent` and
  `total_taxes`, invoice payments), run the suite, then the test-mode run
  below again, then set the live endpoint's version.

### The test-mode run (2026-11-07)

Against the FrameOS sandbox, from a local dev server, real webhooks
through `stripe listen`, a Belgian buyer, Stripe Tax with a Belgian
registration:

| Step | Result |
|---|---|
| Sync plans | 1 product, 4 prices, portal configuration; tax "active"; missing webhook reported |
| Buy Private $5 at Checkout | $5.00 + 21% VAT $1.05; plan granted on return; 3 webhooks applied (`invoice.paid` first); fee €0.53 booked as $0.590638 at Stripe's 0.897334 |
| Upgrade to $9 | $4.00 + $0.84 VAT charged at once, plan switched, fee booked |
| Downgrade to $2, back to $9, cancel, resume | nothing charged, states right at each step |
| Renewal (test clock) after a downgrade to $5 | invoice for $5 + VAT, period opened, plan moved to $5 |
| Renewal with a failing card | `past_due`, plan kept, no period, plan change refused; paid with a new card: period opened |
| Customer portal | our headline, cancel, cards, billing details, invoices; no plan switching |
| Partial refund $3.02 of $6.05 | $2.495867 net and $0.524133 VAT handed back, applied once (two notices) |
| Upgrade on a 3-D Secure card | 402 with the invoice page; plan unchanged until confirmed; after the challenge the plan switched and the payment was booked |
| Dispute (card 0259), lost | refund of $2 + $0.42 VAT booked; the €20 fee came without a rate, which is what made the settlement-rate fallback (fixed and tested) |
| Account deletion | subscription cancelled at Stripe first |
| Cancel, clock past the period end | `customer.subscription.deleted`, plan back to Free |
| Renewal with the webhook listener stopped | nightly reconcile read it back and booked it |
| Ledger integrity after all of it | no violations |

Not seen for real yet: a won dispute, a buyer with an EU VAT number
(reverse charge), a delayed payment method (SEPA Direct Debit), Stripe
giving up after its last retry, a live payment.

## Not built

- The payout reconciliation (what Stripe paid out against
  `asset:psp:main`: conversion, Stripe's own monthly fees).
- Charging for metered AI (an arrears invoice needs the stored card, which
  Stripe has; the postpay design is in `accounting-todo.md` §0).
- A yearly price.
