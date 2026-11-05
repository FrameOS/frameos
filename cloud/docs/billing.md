# Paid plans and the payment provider

The paid plans of FrameOS Cloud are sold through [Creem](https://creem.io), a
merchant of record: Creem (Armitage Labs OÜ, Estonia) is the seller for the
payment. It charges the card, adds and remits VAT or sales tax, sends the
receipt and invoice, and pays us out. We never see a card.

This is the plan half of Phase 3b in [`accounting-todo.md`](accounting-todo.md).
Metered AI (billed in arrears) is not sold through it and nothing bills for AI
yet.

## What is sold

The catalog is `apps/auth-web/src/lib/plan-catalog.ts`. A group with
`selfServe: true` is bought at checkout: **Private** today ($2, $5, $9, $29 a
month). **Business** is `selfServe: false` and stays "contact us" until single
sign-on exists.

A plan lists only what exists. `plannedFeatures` and `plannedLimits` in the
catalog name what is not built yet (sharing frames, virtual frames, single
sign-on, the people count). Every page marks those "planned" and a plan's row
does not grant them. Take a name off those lists in the change that ships the
feature. Creem's review rejects a site that sells what it does not have.

## How it works

```
usage page ── POST /api/account/plan/checkout ──▶ Creem checkout
                                                     │ pays
   ◀── GET /api/account/plan/checkout/return ◀───────┤ (signed redirect)
   ◀── POST /api/webhooks/creem ◀────────────────────┘ (signed webhooks)
```

- **One rule:** an account's plan changes only on what Creem says happened.
  The return from checkout, every webhook and the nightly reconcile hand the
  same thing to `applySubscription` in `src/lib/billing-provider.ts` (the
  subscription as Creem has it now). It is idempotent, so they may arrive in
  any order, any number of times.
- **Creem owns the clock.** A subscription period exists in our books because
  Creem reported a payment for it (`applyProviderPayment` in
  `packages/ledger/src/provider-subscriptions.ts`), with Creem's period
  bounds. The nightly subscription cycle skips these subscriptions
  (`subscriptions.provider = 'creem'`), so nothing waits on the receivable for
  a card that may fail.
- **The books.** A payment posts the period's charge and its payment
  together: `Dr receivable / Cr deferred`, then `Dr asset:psp:main / Cr
  receivable`. The receivable nets to zero and the deferral is earned daily as
  before. Amounts are net of tax. A period's price is what was collected, so a
  discount, a prorated upgrade and a free review purchase are one case.
  Creem's own fee (3.9% + $0.40 a transaction) is not in a payment notice; it
  is booked from the payout report (`expense:psp_fees`, Phase 6).
- **Changing plan.** A larger plan starts now and Creem charges the prorated
  difference (`proration-charge-immediately`). A smaller plan is billed from
  the next renewal (`proration-none`); the account keeps what it paid for
  until then and `next_plan_code` names where it is going. Creem moves its
  own product at once on a downgrade and prorates from that product, so a
  change is always worked out from the plan **paid for** here, never from
  Creem's product: taking a downgrade back charges nothing, and a larger
  plan is charged the difference from what was paid (`changePaidPlan`).
- **Cancelling.** From the usage page, at the period end (`mode: scheduled`).
  It can be taken back until then. Deleting the account cancels at once, and
  the deletion is refused if Creem cannot be told.
- **A failed renewal.** Creem retries the card. The plan stays while it does
  (`past_due`), and the usage page says so. When Creem gives up the
  subscription is cancelled and the account is on Free.
- **Refunds** are issued in the Creem dashboard. The `refund.created` webhook
  takes the amount out of the deferral first and out of revenue for the part
  already earned. A refund does not end the plan; cancel the subscription too
  if that is meant.
- **A webhook that never arrives.** The nightly job reads back every
  subscription whose period has run out (`reconcileSubscriptions`) and applies
  what Creem says.
- **A webhook that cannot be applied** answers 500, so Creem sends it again
  (five tries over a day), and stays in `provider_events` with its error.
  `/admin/billing/payments` lists them. Nothing repairs one automatically.
  A notice for something our checkout did not start (another product in the
  same Creem store) is acknowledged and ignored.

Tables: migration `0073_payment_provider.sql` (`provider_products`,
`provider_subscriptions`, `provider_events`, `provider_payments`). Like every
billing table they reference nothing outside the accounting module. Every row
names its mode.

## Environment

In `/etc/frameos-cloud/auth-web.env`:

| Variable | |
|---|---|
| `CREEM_API_KEY` | From Creem, Developers. A test key starts `creem_test_`. Unset: nothing can be bought and the cards say "Contact support". |
| `CREEM_WEBHOOK_SECRET` | The signing secret of the webhook registered for `https://<cloud host>/api/webhooks/creem`. Required with the key. |
| `CREEM_MODE` | `test` (default) or `live`. Must agree with the key, or the provider is treated as not set up. |
| `FRAMEOS_SUPPORT_EMAIL` | Shown in the footer, on the pricing page and beside the plan cards. Creem requires it to match the support address in its Business Details. |
| `CREEM_TEST_LEDGER` | `1` posts test-mode payments to the ledger. For a development database only. |
| `CREEM_TEST_OPEN` | `1` lets every account check out in test mode on a production build. Leave unset. |
| `CREEM_API_URL` | Test mode only: another API host (the local stand-in). |
| `FRAMEOS_PRICING_URL` | The public price list the footer and `/pricing` lead to. Defaults to `https://frameos.net/pricing/`. |

**Test mode on production is safe.** A test payment grants the plan and is
recorded with `posted = false`; it never reaches the ledger. On a production
build only superadmins can check out in test mode, because a test card would
otherwise be a free plan for anyone.

## Trying it

### Without a Creem account

```
pnpm --filter @frameos-cloud/auth-web creem:fake
```

and in `apps/auth-web/.env.local`:

```
CREEM_API_KEY=creem_test_fake
CREEM_WEBHOOK_SECRET=whsec_fake
CREEM_API_URL=http://localhost:4010
CREEM_TEST_LEDGER=1
```

Then `/admin/billing/payments`, **Sync plans**, and buy a plan from
`/account/usage`. The stand-in serves a checkout page and a billing portal
with buttons for a month passing, a failed payment, a cancellation and a
refund. It is our reading of Creem's documentation
(`src/test/creem-fake.ts`), which the integration tests also run against.

### Against Creem's test mode

The store is set up (2026-11-06): the four Private products exist in test
mode, the webhook `FrameOS Cloud` points at
`https://cloud.frameos.net/api/webhooks/creem`, cancellation is "at period
end", and business details and the checkout logo are filled in.

1. On a laptop, `creem listen --forward-to
   http://localhost:3000/api/webhooks/creem` forwards the store's webhooks
   and prints a signing secret for the session. On a server, use the secret
   of the registered webhook: `creem webhooks secret <id>`.
2. Set `CREEM_API_KEY` and `CREEM_WEBHOOK_SECRET`, restart.
3. `/admin/billing/payments` → **Sync plans**. It adopts the products the
   store already has (matched by name and price) and creates any that are
   missing, so a second deployment sells the same products.
4. Buy a plan with card `4111 1111 1111 1111` (any future date, any CVC).
   `4507 9900 0000 0028` is declined.

**The app must be on `localhost` or on a host without a port.** Creem
refuses a return URL with a port on anything but `localhost`
(`http://127.0.0.1:3100`, `http://lvh.me:3100` and `*.localhost` are all
"URL must be valid"). Cookies on `localhost` are shared across ports, so a
second dev stack in the same browser profile shares its session cookie name
with the first; use another profile.

Run against the real test API on 2026-11-06, all as the code expects:

| Check | What Creem did |
|---|---|
| Buy Private $2 | `subscription.paid` then `checkout.completed`; the signed return (parameters in the order `request_id, checkout_id, order_id, customer_id, subscription_id, product_id`) verified and landed on "Your plan is active". One payment, $2.00 net, VAT recorded beside it. |
| Switch to $9 | Plan $9 at once. Creem charged the prorated difference and kept the billing date. The charge was **not** on the answer to the change: `subscription.update` and `subscription.paid` followed two seconds later and booked it. |
| Switch to $5 | `subscription.update`. Plan stayed $9, moving to `private-5` at the renewal. |
| Cancel, then Keep this plan | `subscription.scheduled_cancel`, then `subscription.active`. No charge. |
| Manage billing | A portal link on creem.io. |
| Refund (`creem transactions refund`) | `refund.created`, booked net of tax. |
| Cancel at once (`creem subscriptions cancel --mode immediate`) | `subscription.canceled`; the account is on Free. |

Not yet seen for real: a renewal, a failed renewal (`past_due`), and a
scheduled cancellation taking effect, since all three need a month to pass.
The nightly reconcile covers a renewal whose webhook is missed.

## Going live

Creem reviews the account before it can take live payments
([checklist](https://docs.creem.io/merchant-of-record/account-reviews/account-reviews)).
Where each requirement stands:

| Requirement | Status |
|---|---|
| Product is live | cloud.frameos.net is in production. |
| Own custom domain | frameos.net. |
| No false information | No testimonials or user counts anywhere. Unbuilt features are marked "planned" and not sold. |
| Privacy Policy and Terms of Service | `/legal/privacy`, `/legal/terms`, readable signed out. Both cover paid plans and Creem. |
| Product clearly visible | frameos.net is the product site. |
| Pricing is visible | `https://frameos.net/pricing` on the product site (top nav and footer), linked from the footer of every public page here. The cloud has no price list of its own: `/pricing` sends a signed-in account to its usage page and everyone else to the product site. |
| Customer support email | `FRAMEOS_SUPPORT_EMAIL`: footer, the usage page, the refund policy. |
| Cancel from inside the product | Usage page, "Cancel my paid plan"; also the Creem portal behind "Manage billing". |
| Refund policy | `/legal/refunds`. |
| Moderation API | Not applicable: see below. |
| Not on the prohibited list | See below. |

To do, in order:

1. **Deploy this in test mode**: `CREEM_API_KEY` is the test key and
   `CREEM_WEBHOOK_SECRET` comes from `creem webhooks secret <id>` for the
   `FrameOS Cloud` webhook. Press **Sync plans** (it adopts the existing
   test products). Confirm the footer on the live site, then
   buy a plan as a superadmin with the test card.
2. **Set `FRAMEOS_SUPPORT_EMAIL`** to a branded address that is read
   (Creem expects an answer within 3 business days and may refund on our
   behalf otherwise), and use the same address in Creem's Settings, Business
   Details.
3. **Keep the public price list in step.** `https://frameos.net/pricing`
   (`content/docs/pricing.mdx` in the `frameos-docs` repo) is the one public
   price list. It repeats the catalog's numbers by hand, and says paid plans
   "are being opened up now". When the catalog changes, or once checkout is
   live for everyone, edit it. `FRAMEOS_PRICING_URL` points the footer and
   `/pricing` somewhere else.
4. **Read the three legal pages as the owner.** They state a 14-day refund, a
   30-day notice of price changes and how long payment records are kept.
   Those are commitments.
5. **Submit for review** in Creem: Balance, Payout Account. Website URL
   `https://frameos.net`. Reviewers
   may make a test purchase with a 100% discount: it grants the plan and posts
   nothing.
6. **When approved:** create a live API key and a live webhook, set
   `CREEM_MODE=live` with both, restart, **Sync plans** again (live products
   are separate from test ones), and buy the $2 plan with a real card. Refund
   it from the Creem dashboard. Test purchases made before the switch keep
   their plan to the end of the month they were granted for and then lapse
   (the nightly job ends them).

How to describe the product to Creem, since two of its lists come close:

- **Not an AI image or video generator.** The plans sell capacity for
  managing frames (frames, storage). The AI assistant writes scene code (text)
  and is not what a plan buys. Images a scene generates are made on the
  customer's own device with the customer's own OpenAI key. So the Moderation
  API requirement does not apply. If a reviewer asks, that is the answer; if
  the cloud ever generates images from prompts on its own key, it will.
- **Not file sharing.** Photo albums are private storage shown on the
  owner's own frames. Photo bytes are never public (`docs/photos.md`).
- **No hardware.** Nothing physical is sold. Frames are the customer's own.

## Not built

- Charging for metered AI. Creem sells subscriptions; an arrears invoice for
  usage needs its own design (Creem's usage-based billing or a monthly
  one-time checkout).
- Creem's fee and payouts in the books (Phase 6 reconciliation).
- A yearly price.
- Dispute notices (`dispute.created`) are recorded and not acted on.
