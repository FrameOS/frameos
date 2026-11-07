# Paid plans and the payment provider

The paid plans of FrameOS Cloud have everything but a payment provider.
This doc says what is built, what an adapter has to do, and why the first
adapter was removed.

**Stripe is the plan** (decided 2026-11-07, not started). A Creem adapter
was built on 2026-11-05 and run end to end against Creem's test mode, then
removed on 2026-11-07: Creem's account review required its content
moderation API on every "prompt-based generation endpoint", meaning the
prompts that reach the OpenAI image app, which runs on the customer's own
frame with the customer's own key. That is not ours to police, and a
merchant of record that reviews the product is a gatekeeper this project
does not want. Stripe has no such review; the price is that VAT is ours to
remit (Stripe Tax collects it) and chargebacks are ours.

## What is sold

The catalog is `apps/auth-web/src/lib/plan-catalog.ts`. A group with
`selfServe: true` is meant to be bought at checkout: **Private** ($2, $5,
$9, $29 a month). **Business** is `selfServe: false` and stays "contact
us" until single sign-on exists. Until an adapter exists every paid card
says "Contact support to activate" and an operator moves the account by
hand (`/admin/billing/customers`, after **Sync plans** has written the
`billing_plans` rows).

A plan lists only what exists. `plannedFeatures` and `plannedLimits` in
the catalog name what is not built yet; every page marks those "planned"
and a plan's row does not grant them. Take a name off those lists in the
change that ships the feature.

## What is built

- **Ledger:** `packages/ledger/src/provider-subscriptions.ts`. The provider
  owns the clock: a subscription period exists because the provider
  reported a payment for it (`applyProviderPayment`, with the provider's
  period bounds, priced at what was collected net of tax), and the charge
  and the payment post together (`Dr receivable / Cr deferred`, then
  `Dr asset:psp:main / Cr receivable`, `rules/payment.ts`), so nothing
  waits on the receivable. A payment in the middle of a running period (a
  prorated upgrade) carries the unearned rest over. `applyProviderRefund`
  takes a refund out of the deferral first and out of revenue for the part
  already earned. `setProviderSubscriptionState` follows active /
  scheduled-to-cancel / cancelled. The nightly cycle skips
  `subscriptions.provider` rows. `post: false` is test mode: the plan is
  granted and nothing reaches the ledger.
- **Tables** (migration 0073): `provider_products` (plan code to the
  provider's product, per mode), `provider_subscriptions` (the provider's
  view), `provider_events` (every webhook once, by the provider's event id,
  customer details stripped), `provider_payments` (every transaction once,
  net of tax). No foreign key leaves the accounting module; every row names
  its mode.
- **Plan cards** (`frontend/src/scenes/settings/account/plansLogic.ts`):
  the buy, switch, keep and cancel actions, driven by `billing` and
  `purchasable` in `GET /api/account/plan`, and the return from checkout
  (`/account/usage?checkout=active|pending|failed`). With `billing.checkout`
  false they fall back to "Contact support".
- **Pages:** `/legal/refunds`, the paid-plans sections of the terms and the
  privacy policy (provider named at checkout), the public price list on
  frameos.net (`FRAMEOS_PRICING_URL`), the support address in the footer.
- **Operators:** "Sync plans" on `/admin/billing/customers` writes the
  self-serve stops' rows (`src/lib/plan-rows.ts`). The operator plan route
  refuses an account whose subscription a provider bills.
- **Account deletion** keeps a paid period (it is earned to its end) and
  ends the plan; an adapter must cancel at the provider first and refuse
  the deletion if it cannot.

## What a provider adapter has to do

One module, say `src/lib/stripe.ts` (the API and its signatures) plus
`src/lib/billing-provider.ts` (the mapping), with:

1. **Products:** extend `syncPlanRows` to create the provider's prices for
   each self-serve stop and record them in `provider_products`, adopting
   ones the store already has by name and price so two deployments share
   them. Stripe: one Product per group, one recurring Price per stop.
2. **Checkout:** `POST /api/account/plan/checkout` creates a hosted
   checkout with the account id in metadata and a return URL; browser
   sessions only, verified email. `purchasablePlanCodes` fills
   `purchasable` on the catalog; in test mode, superadmins only on a
   production build.
3. **One function** the return, every webhook and a nightly reconcile hand
   the provider's subscription to, idempotent on the provider's transaction
   id: resolve the account from metadata (trusted because the webhook is
   signed), map product to plan, call `applyProviderPayment` for an unseen
   paid transaction, treat a dearer product without a payment yet as a
   switch now and a cheaper one as `next_plan_code`, then set the state.
   Ignore notices for a replaced subscription. Record failures on the event
   row and answer 500 so the provider retries; acknowledge and ignore what
   our checkout did not start.
4. **Changes:** work out a change from the plan **paid for**
   (`subscriptions.plan_code`), never the provider's current product: a
   downgrade moves the provider's product at once, so taking it back must
   charge nothing, and a larger plan is prorated from what was paid.
   Cancel at period end; resume withdraws it. Stripe: `proration_behavior`
   on the subscription update, `cancel_at_period_end`.
5. **Portal:** `POST /api/account/plan/portal` for invoices and the card.
6. **Reconcile** in the nightly job: read back subscriptions whose period
   ran out, and let subscriptions of the other mode lapse.
7. **Webhook route:** raw body, signature check, 1 MB cap, 503 when not
   configured.
8. **Tests:** a stand-in for the provider's API that the integration suite
   drives, then the same flow against the provider's real test mode before
   it goes live. The Creem run (buy, signed return, upgrade, downgrade,
   cancel and resume, refund, immediate cancel) is the checklist; a
   renewal and a failed renewal need a month to pass.

## Environment

| Variable | |
|---|---|
| `FRAMEOS_SUPPORT_EMAIL` | The support address in the footer and beside the plan cards. |
| `FRAMEOS_PRICING_URL` | The public price list the footer and `/pricing` lead to. Defaults to `https://frameos.net/pricing/`. |

## Not built

- The provider adapter (above).
- Charging for metered AI. A hosted checkout sells subscriptions; an
  arrears invoice for usage needs a stored payment method, which Stripe has.
- A yearly price.
