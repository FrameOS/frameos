import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import {
  accounts,
  providerEvents,
  providerPayments,
  providerProducts,
  providerSubscriptions,
  subscriptions,
  type createDb,
} from "@frameos-cloud/db";
import {
  addMonth,
  applyProviderFee,
  applyProviderPayment,
  applyProviderRefund,
  noteProviderNextPlan,
  readPlan,
  setProviderSubscriptionState,
} from "@frameos-cloud/ledger";
import type { PlanGroupKey } from "./plan-catalog";
import { syncPlanRows } from "./plan-rows";
import {
  accountChecks,
  cancelSubscriptionNow,
  centsToMicros,
  changeSubscriptionPrice,
  createCheckoutSession,
  createMonthlyPrice,
  createPortalSession,
  ensurePortalConfiguration,
  ensureProduct,
  invoiceCharge,
  invoiceForCharge,
  listCustomerInvoices,
  metadataKeys,
  parseCheckoutSession,
  parseDispute,
  parseRefund,
  pricesByLookupKey,
  retrieveCheckoutSession,
  retrieveDispute,
  retrieveInvoice,
  retrieveRefund,
  retrieveSubscription,
  setCancelAtPeriodEnd,
  stripeProvider,
  verifyWebhook,
  type PortalSpec,
  type StripeAccountChecks,
  type StripeConfig,
  type StripeDisputeFacts,
  type StripeFeeFacts,
  type StripeFetch,
  type StripeInvoiceFacts,
  type StripeMode,
  type StripeRefundFacts,
  type StripeSetup,
  type StripeSubscriptionFacts,
} from "./stripe";

// Paid plans, collected by Stripe (cloud/docs/billing.md).
//
// One rule runs through this file: what an account is entitled to changes
// only on what Stripe says happened. A checkout that returns, a webhook and
// the nightly reconcile all hand the same thing to `applySubscription` (the
// subscription as Stripe holds it now, read back from its API), and that
// function is idempotent, so the three may arrive in any order and any
// number of times.
//
//  - A paid invoice puts the account on the plan it paid for and opens the
//    period (the ledger's applyProviderPayment), with the VAT in it booked
//    as owed and Stripe's fee as a cost.
//  - A dearer price without a paid invoice yet switches the plan at once;
//    the charge is booked when its invoice is reported paid.
//  - A cheaper price is where the account goes at the next renewal. It
//    keeps what it paid for until then.
//  - A cancellation runs to the end of the period paid for.

type Database = ReturnType<typeof createDb>;

export class BillingError extends Error {
  readonly code: string;
  /** Extra fields for the response body (a URL to finish a payment at). */
  readonly extra: Record<string, unknown>;
  readonly status: number;

  constructor(code: string, status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "BillingError";
    this.code = code;
    this.extra = extra;
    this.status = status;
  }
}

type Env = Record<string, string | undefined>;

function flag(value: string | undefined): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Whether a payment reaches the ledger. Live ones do. Test ones are
 * recorded and grant the plan, and post nothing: a wiring check against the
 * production database must not invent revenue. STRIPE_TEST_LEDGER=1 posts
 * them anyway, for a development database.
 */
export function postsToLedger(mode: StripeMode, env: Env = process.env): boolean {
  return mode === "live" || flag(env.STRIPE_TEST_LEDGER);
}

/**
 * Who may check out. Operators always. In live mode everyone else only once
 * STRIPE_CHECKOUT_OPEN is set, so the first real payment can be made and
 * refunded before the plans are on sale; a development build is no
 * exception, a live key is real money. In test mode a plan can be had with a
 * test card, so on a production build it stays the operators' unless
 * STRIPE_TEST_OPEN is set.
 */
export function checkoutOpenTo(
  mode: StripeMode,
  superadmin: boolean,
  env: Env = process.env,
): boolean {
  if (superadmin) {
    return true;
  }
  if (mode === "live") {
    return flag(env.STRIPE_CHECKOUT_OPEN);
  }
  return env.NODE_ENV !== "production" || flag(env.STRIPE_TEST_OPEN);
}

// Statuses in which Stripe still bills, or will again. "incomplete" is not
// one: its first payment never went through, and it expires on its own.
const liveStatuses = new Set(["active", "trialing", "past_due", "unpaid", "scheduled_cancel"]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Plans and prices ----

// Stripe Tax's product tax codes: software as a service, for a person or
// for a business. In the EU both are electronically supplied services; the
// difference matters in US states.
const taxCodes: Record<PlanGroupKey, string> = {
  business: "txcd_10103001",
  free: "txcd_10103000",
  private: "txcd_10103000",
};

/**
 * The lookup key a stop's price is found by. It names everything that makes
 * a Stripe price what it is (a price cannot change its amount), so a new
 * number in the catalog is a new key and a new price, and two deployments
 * on one Stripe account sell the same prices.
 */
export function priceLookupKey(
  code: string,
  currency: string,
  cents: number,
  taxBehavior: string,
): string {
  return `frameos-cloud:${code}:${currency.toLowerCase()}:${cents}:month:${taxBehavior}`;
}

export interface PlanSyncResult {
  code: string;
  /** Made at Stripe by this run. */
  created: boolean;
  priceId: string;
}

export interface ProviderSyncResult {
  checks: StripeAccountChecks;
  plans: PlanSyncResult[];
  portal: { created: boolean; id: string };
}

/**
 * Give every self-serve stop its billing_plans row and its price at Stripe,
 * in the mode the deployment is in, plus the customer portal's settings.
 * Stripe's own list is the truth about which prices exist:
 *
 *  - the price our row names is still active under the stop's key: kept;
 *  - Stripe already has an active price under the key (another deployment
 *    synced first, or the row was lost): adopted;
 *  - otherwise one is created, under the plan group's product.
 *
 * Safe to run again at any time.
 */
export async function syncPlans(
  db: Database,
  config: StripeConfig,
  urls: PortalSpec & { webhookUrl: string },
  fetchImpl?: StripeFetch,
): Promise<ProviderSyncResult> {
  const rows = await syncPlanRows(db);
  const lookupKeys = rows.map((row) =>
    priceLookupKey(row.code, "USD", row.entry.stop.usd * 100, config.taxBehavior),
  );
  const atStripe = await pricesByLookupKey(config, lookupKeys, fetchImpl);
  const products = new Map<string, string>();
  const results: PlanSyncResult[] = [];

  for (const [index, row] of rows.entries()) {
    const lookupKey = lookupKeys[index]!;
    const cents = row.entry.stop.usd * 100;
    const [existing] = await db
      .select()
      .from(providerProducts)
      .where(
        and(
          eq(providerProducts.provider, stripeProvider),
          eq(providerProducts.mode, config.mode),
          eq(providerProducts.planCode, row.code),
          eq(providerProducts.active, true),
        ),
      )
      .orderBy(desc(providerProducts.createdAt))
      .limit(1);
    const live = atStripe.find((price) => price.lookupKey === lookupKey);
    if (existing && existing.priceMicros === row.priceMicros && live?.id === existing.productId) {
      results.push({ code: row.code, created: false, priceId: existing.productId });
      continue;
    }
    const adopted =
      live &&
      live.unitAmountCents === cents &&
      live.currency === "USD" &&
      live.interval === "month" &&
      live.taxBehavior === config.taxBehavior
        ? live
        : undefined;
    let priceId = adopted?.id;
    if (!priceId) {
      let productId = products.get(row.entry.group);
      if (!productId) {
        productId = (
          await ensureProduct(
            config,
            {
              description: `FrameOS Cloud ${row.entry.groupName}: more frames, more storage and virtual frames for your FrameOS frames. Billed monthly, cancel any time.`,
              key: row.entry.group,
              name: `FrameOS Cloud ${row.entry.groupName}`,
              taxCode: taxCodes[row.entry.group],
            },
            fetchImpl,
          )
        ).id;
        products.set(row.entry.group, productId);
      }
      priceId = (
        await createMonthlyPrice(
          config,
          {
            currency: "USD",
            lookupKey,
            metadata: { [metadataKeys.planCode]: row.code },
            nickname: `${row.entry.groupName} $${row.entry.stop.usd}/month`,
            productId,
            unitAmountCents: cents,
          },
          fetchImpl,
        )
      ).id;
    }
    const newPriceId = priceId;
    await db.transaction(async (tx) => {
      await tx
        .update(providerProducts)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(providerProducts.provider, stripeProvider),
            eq(providerProducts.mode, config.mode),
            eq(providerProducts.planCode, row.code),
          ),
        );
      await tx
        .insert(providerProducts)
        .values({
          mode: config.mode,
          planCode: row.code,
          priceMicros: row.priceMicros,
          productId: newPriceId,
          provider: stripeProvider,
        })
        .onConflictDoUpdate({
          set: { active: true, planCode: row.code, priceMicros: row.priceMicros, updatedAt: new Date() },
          target: [providerProducts.provider, providerProducts.mode, providerProducts.productId],
        });
    });
    results.push({ code: row.code, created: !adopted, priceId: newPriceId });
  }

  const portal = await ensurePortalConfiguration(config, urls, fetchImpl);
  const checks = await accountChecks(config, urls.webhookUrl, fetchImpl);
  return { checks, plans: results, portal };
}

/** The plan codes this visitor can take at checkout right now. */
export async function purchasablePlanCodes(
  db: Database,
  setup: StripeSetup,
  superadmin: boolean,
): Promise<Set<string>> {
  if (!setup.config || !checkoutOpenTo(setup.config.mode, superadmin)) {
    return new Set();
  }
  const rows = await db
    .select({ planCode: providerProducts.planCode })
    .from(providerProducts)
    .where(
      and(
        eq(providerProducts.provider, stripeProvider),
        eq(providerProducts.mode, setup.config.mode),
        eq(providerProducts.active, true),
      ),
    );
  return new Set(rows.map((row) => row.planCode));
}

async function activePriceFor(db: Database, mode: StripeMode, planCode: string) {
  const [row] = await db
    .select()
    .from(providerProducts)
    .where(
      and(
        eq(providerProducts.provider, stripeProvider),
        eq(providerProducts.mode, mode),
        eq(providerProducts.planCode, planCode),
        eq(providerProducts.active, true),
      ),
    )
    .orderBy(desc(providerProducts.createdAt))
    .limit(1);
  return row;
}

async function planCodeForPrice(db: Database, mode: StripeMode, priceId: string) {
  const [row] = await db
    .select({ planCode: providerProducts.planCode })
    .from(providerProducts)
    .where(
      and(
        eq(providerProducts.provider, stripeProvider),
        eq(providerProducts.mode, mode),
        eq(providerProducts.productId, priceId),
      ),
    )
    .limit(1);
  return row?.planCode;
}

// ---- The account's subscription at Stripe ----

type ProviderSubscriptionRow = typeof providerSubscriptions.$inferSelect;

/** The newest subscription Stripe holds for the account in this mode. */
export async function latestProviderSubscription(
  db: Database,
  mode: StripeMode,
  accountId: string,
): Promise<ProviderSubscriptionRow | undefined> {
  const [row] = await db
    .select()
    .from(providerSubscriptions)
    .where(
      and(
        eq(providerSubscriptions.provider, stripeProvider),
        eq(providerSubscriptions.mode, mode),
        eq(providerSubscriptions.accountId, accountId),
      ),
    )
    .orderBy(desc(providerSubscriptions.createdAt))
    .limit(1);
  return row;
}

async function liveProviderSubscription(db: Database, mode: StripeMode, accountId: string) {
  const row = await latestProviderSubscription(db, mode, accountId);
  return row && liveStatuses.has(row.status) ? row : undefined;
}

// Where the tax a checkout adds is called VAT: the EU, the rest of the
// single market and its neighbours. Elsewhere it is "tax" (a sales tax, a
// GST), or nothing where we are not registered, which checkout shows.
const vatCountries = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU",
  "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
  "CH", "GB", "IS", "LI", "MC", "NO",
]);

/**
 * What a price before tax is followed by ("+ VAT"), for a visitor in this
 * country: Cloudflare's CF-IPCountry, a two-letter code. A guess from the
 * connection, so only ever a word next to a price; checkout reads the
 * billing address and is what charges.
 */
export function taxLabelFor(country: string | null | undefined): "VAT" | "tax" {
  return vatCountries.has((country ?? "").trim().toUpperCase()) ? "VAT" : "tax";
}

export interface BillingSummary {
  /** A card can be charged here: Stripe is set up for this visitor. */
  checkout: boolean;
  /** Stripe's customer portal can be opened. */
  manage: boolean;
  mode: StripeMode | null;
  /** Prices are shown before tax, which checkout adds for the buyer's country. */
  prices_exclude_tax: boolean;
  /** The word after a price before tax, for where the visitor seems to be; null when prices include it. */
  tax_label: "VAT" | "tax" | null;
  subscription: {
    cancel_at: string | null;
    /** The last charge failed and Stripe is retrying. */
    past_due: boolean;
    plan_code: string | null;
    renews_at: string | null;
    status: string;
  } | null;
}

export async function billingSummary(
  db: Database,
  setup: StripeSetup,
  accountId: string,
  superadmin: boolean,
  country: string | null = null,
): Promise<BillingSummary> {
  if (!setup.config) {
    return {
      checkout: false,
      manage: false,
      mode: null,
      prices_exclude_tax: false,
      subscription: null,
      tax_label: null,
    };
  }
  const row = await latestProviderSubscription(db, setup.config.mode, accountId);
  const live = row && liveStatuses.has(row.status) ? row : undefined;
  const scheduled = live?.status === "scheduled_cancel";
  const excludeTax = setup.config.automaticTax && setup.config.taxBehavior === "exclusive";
  return {
    checkout: checkoutOpenTo(setup.config.mode, superadmin),
    manage: Boolean(row?.customerId),
    mode: setup.config.mode,
    prices_exclude_tax: excludeTax,
    tax_label: excludeTax ? taxLabelFor(country) : null,
    subscription: live
      ? {
          cancel_at: scheduled ? (live.currentPeriodEnd?.toISOString() ?? null) : null,
          past_due: live.status === "past_due" || live.status === "unpaid",
          plan_code: live.planCode,
          renews_at: scheduled ? null : (live.currentPeriodEnd?.toISOString() ?? null),
          status: live.status,
        }
      : null,
  };
}

// ---- Checkout ----

export async function startCheckout(
  db: Database,
  config: StripeConfig,
  input: {
    accountId: string;
    cancelUrl: string;
    email: string;
    planCode: string;
    /** Where Stripe sends the browser back; `session_id` is added to it. */
    returnUrl: string;
  },
  fetchImpl?: StripeFetch,
): Promise<{ url: string }> {
  const price = await activePriceFor(db, config.mode, input.planCode);
  if (!price) {
    throw new BillingError("plan_not_for_sale", 404, "This plan cannot be bought here.");
  }
  if (await liveProviderSubscription(db, config.mode, input.accountId)) {
    throw new BillingError(
      "already_subscribed",
      409,
      "This account already has a paid plan. Change it instead of buying a second one.",
    );
  }
  const previous = await latestProviderSubscription(db, config.mode, input.accountId);
  const separator = input.returnUrl.includes("?") ? "&" : "?";
  const checkout = await createCheckoutSession(
    config,
    {
      accountId: input.accountId,
      cancelUrl: input.cancelUrl,
      customerId: previous?.customerId ?? null,
      email: input.email,
      idempotencyKey: `frameos-cloud-checkout:${input.accountId}:${randomUUID()}`,
      planCode: input.planCode,
      priceId: price.productId,
      // Stripe fills in the placeholder; it must reach Stripe unencoded.
      successUrl: `${input.returnUrl}${separator}session_id={CHECKOUT_SESSION_ID}`,
    },
    fetchImpl,
  );
  return { url: checkout.url };
}

// ---- Applying Stripe's state ----

export interface ApplyResult {
  accountId: string;
  paymentApplied: boolean;
  planCode: string;
}

async function accountExists(db: Database, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return Boolean(row);
}

async function paymentRow(db: Database, mode: StripeMode, invoiceId: string) {
  const [row] = await db
    .select()
    .from(providerPayments)
    .where(
      and(
        eq(providerPayments.provider, stripeProvider),
        eq(providerPayments.mode, mode),
        eq(providerPayments.kind, "payment"),
        eq(providerPayments.transactionId, invoiceId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * A fee in the payment's currency. Stripe keeps its balance in the
 * account's settlement currency (euros for Raaven BV), so a dollar charge's
 * fee arrives in euros with the rate Stripe converted at; the books are in
 * dollars and take the fee at that same rate. A fee charged in euros to
 * begin with (a dispute's) carries no rate, and takes the rate its charge
 * was settled at (`fallback`). Null when there is no rate at all, which
 * leaves the fee to a person.
 */
export function feeMicrosIn(
  fee: StripeFeeFacts,
  currency: string,
  fallback: { currency: string; exchangeRate: number } | null = null,
): bigint | null {
  if (fee.currency === currency.toUpperCase()) {
    return centsToMicros(fee.amountMinor);
  }
  const rate =
    fee.exchangeRate && fee.exchangeRate > 0
      ? fee.exchangeRate
      : fallback && fallback.currency === fee.currency && fallback.exchangeRate > 0
        ? fallback.exchangeRate
        : null;
  return rate ? BigInt(Math.round((fee.amountMinor / rate) * 10_000)) : null;
}

/** The rate a payment's charge settled at, from its fee row. */
async function settlementRateOf(
  db: Database,
  mode: StripeMode,
  paymentRef: string | null,
): Promise<{ currency: string; exchangeRate: number } | null> {
  if (!paymentRef) {
    return null;
  }
  const [row] = await db
    .select({ details: providerPayments.details })
    .from(providerPayments)
    .where(
      and(
        eq(providerPayments.provider, stripeProvider),
        eq(providerPayments.mode, mode),
        eq(providerPayments.kind, "fee"),
        eq(providerPayments.paymentRef, paymentRef),
      ),
    )
    .limit(1);
  const settlement = row?.details["settlement"] as
    | { currency?: unknown; exchange_rate?: unknown }
    | undefined;
  return settlement &&
    typeof settlement.currency === "string" &&
    typeof settlement.exchange_rate === "number"
    ? { currency: settlement.currency, exchangeRate: settlement.exchange_rate }
    : null;
}

async function feeRecorded(db: Database, mode: StripeMode, paymentRef: string | null) {
  if (!paymentRef) {
    return false;
  }
  const [row] = await db
    .select({ id: providerPayments.id })
    .from(providerPayments)
    .where(
      and(
        eq(providerPayments.provider, stripeProvider),
        eq(providerPayments.mode, mode),
        eq(providerPayments.kind, "fee"),
        eq(providerPayments.paymentRef, paymentRef),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Book what a paid invoice's charge cost: find the charge (so a refund or a
 * dispute can find this payment), and post Stripe's fee. Idempotent: a fee
 * is booked once per balance transaction. Returns false when Stripe has not
 * settled the charge yet; the nightly reconcile comes back for it.
 */
export async function completePaymentDetails(
  db: Database,
  config: StripeConfig,
  payment: typeof providerPayments.$inferSelect,
  fetchImpl?: StripeFetch,
): Promise<boolean> {
  if (payment.amountMicros === 0n && payment.taxMicros === 0n) {
    return true;
  }
  const charge = await invoiceCharge(config, payment.transactionId, fetchImpl);
  if (!charge) {
    return false;
  }
  if (payment.paymentRef !== charge.chargeId) {
    await db
      .update(providerPayments)
      .set({ paymentRef: charge.chargeId })
      .where(eq(providerPayments.id, payment.id));
  }
  if (!charge.fee) {
    return false;
  }
  const micros = feeMicrosIn(charge.fee, payment.currency);
  await applyProviderFee(db, {
    accountId: payment.accountId,
    amountMicros: micros ?? 0n,
    currency: payment.currency,
    details: {
      invoice: payment.transactionId,
      settlement: {
        amount_minor: charge.fee.amountMinor,
        currency: charge.fee.currency,
        exchange_rate: charge.fee.exchangeRate,
        ...(micros === null ? { unconverted: true } : {}),
      },
    },
    feeId: charge.fee.balanceTransactionId,
    mode: config.mode,
    occurredAt: payment.occurredAt,
    paymentRef: charge.chargeId,
    planCode: payment.planCode,
    post: payment.posted,
    provider: stripeProvider,
    subscriptionId: payment.subscriptionId,
  });
  return true;
}

/**
 * Make our side agree with Stripe's subscription as it stands. `invoice` is
 * a paid invoice a notice carried beside the subscription; otherwise the
 * subscription's own latest invoice is the payment to apply, when it is paid.
 */
export async function applySubscription(
  db: Database,
  config: StripeConfig,
  subscription: StripeSubscriptionFacts,
  hint: { fetchImpl?: StripeFetch | undefined; invoice?: StripeInvoiceFacts | null | undefined } = {},
): Promise<ApplyResult> {
  const mode = config.mode;
  const [known] = await db
    .select()
    .from(providerSubscriptions)
    .where(
      and(
        eq(providerSubscriptions.provider, stripeProvider),
        eq(providerSubscriptions.mode, mode),
        eq(providerSubscriptions.subscriptionId, subscription.id),
      ),
    )
    .limit(1);

  // The account a subscription belongs to is fixed by the checkout we made
  // for it. Once recorded it does not move, whatever later metadata says.
  let accountId = known?.accountId;
  if (!accountId) {
    const claimed = subscription.metadata[metadataKeys.accountId] ?? "";
    if (!claimed) {
      // Not made by our checkout: something else sold on the same account.
      throw new BillingError(
        "not_ours",
        422,
        `Subscription ${subscription.id} was not started from this service`,
      );
    }
    if (!uuidPattern.test(claimed) || !(await accountExists(db, claimed.toLowerCase()))) {
      throw new BillingError(
        "unknown_account",
        422,
        `Subscription ${subscription.id} names no account of ours`,
      );
    }
    accountId = claimed.toLowerCase();
  }

  const priceId = subscription.priceId ?? known?.productId ?? null;
  const planCode = priceId ? await planCodeForPrice(db, mode, priceId) : undefined;
  if (!priceId || !planCode) {
    throw new BillingError(
      "unknown_product",
      422,
      `Subscription ${subscription.id} is for a price no plan is mapped to (${priceId ?? "none"})`,
    );
  }
  const plan = await readPlan(db, planCode);
  if (!plan) {
    throw new BillingError("unknown_plan", 422, `Plan ${planCode} has no billing_plans row`);
  }

  const now = new Date();
  await db
    .insert(providerSubscriptions)
    .values({
      accountId,
      canceledAt: subscription.canceledAt,
      currentPeriodEnd: subscription.periodEnd,
      currentPeriodStart: subscription.periodStart,
      customerId: subscription.customerId,
      mode,
      planCode,
      productId: priceId,
      provider: stripeProvider,
      status: subscription.status,
      subscriptionId: subscription.id,
    })
    .onConflictDoUpdate({
      set: {
        canceledAt: subscription.canceledAt,
        planCode,
        productId: priceId,
        status: subscription.status,
        updatedAt: now,
        ...(subscription.periodEnd ? { currentPeriodEnd: subscription.periodEnd } : {}),
        ...(subscription.periodStart ? { currentPeriodStart: subscription.periodStart } : {}),
        ...(subscription.customerId ? { customerId: subscription.customerId } : {}),
      },
      target: [
        providerSubscriptions.provider,
        providerSubscriptions.mode,
        providerSubscriptions.subscriptionId,
      ],
    });

  const post = postsToLedger(mode);
  let paymentApplied = false;
  const invoice = hint.invoice ?? subscription.latestInvoice;
  if (invoice && invoice.paid && invoice.subscriptionId === subscription.id) {
    if (invoice.currency !== plan.currency) {
      // Adaptive pricing would do this; checkout turns it off. The books
      // keep one currency, so a person converts this one by hand.
      throw new BillingError(
        "currency_mismatch",
        422,
        `Invoice ${invoice.id} was paid in ${invoice.currency}; plan ${plan.code} is priced in ${plan.currency}`,
      );
    }
    // The plan this invoice paid for is its own line's price: a renewal
    // after a downgrade pays for the smaller plan even when a later change
    // has moved the subscription again by the time it is read.
    const paidPlanCode =
      (invoice.priceId ? await planCodeForPrice(db, mode, invoice.priceId) : undefined) ?? planCode;
    const periodStart = invoice.periodStart ?? subscription.periodStart ?? now;
    const periodEnd = invoice.periodEnd ?? subscription.periodEnd ?? addMonth(periodStart);
    const taxCents = Math.min(invoice.taxCents, invoice.amountPaidCents);
    const result = await applyProviderPayment(db, {
      accountId,
      amountMicros: centsToMicros(Math.max(0, invoice.amountPaidCents - taxCents)),
      currency: invoice.currency,
      details: {
        billing_reason: invoice.billingReason,
        ...(invoice.number ? { invoice_number: invoice.number } : {}),
      },
      mode,
      occurredAt: invoice.paidAt ?? undefined,
      periodEnd,
      periodStart,
      planCode: paidPlanCode,
      post,
      provider: stripeProvider,
      subscriptionId: subscription.id,
      taxMicros: centsToMicros(taxCents),
      // Stripe is not a merchant of record: the VAT it added is ours to pay
      // over (liability:sales_tax).
      taxRemittedBy: "us",
      transactionId: invoice.id,
    });
    paymentApplied = result.applied;
    const row = await paymentRow(db, mode, invoice.id);
    if (row && (!row.paymentRef || !(await feeRecorded(db, mode, row.paymentRef)))) {
      try {
        await completePaymentDetails(db, config, row, hint.fetchImpl);
      } catch {
        // The payment and the plan stand; the fee is booked by the nightly
        // reconcile once Stripe answers.
      }
    }
  }

  // Everything below is about the account's CURRENT subscription. A late
  // notice for one it replaced must not end the plan the new one pays for.
  const latest = await latestProviderSubscription(db, mode, accountId);
  if (latest?.subscriptionId !== subscription.id) {
    return { accountId, paymentApplied, planCode };
  }

  if (!paymentApplied && liveStatuses.has(subscription.status)) {
    const [ours] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId))
      .limit(1);
    if (ours && ours.provider === stripeProvider && ours.status !== "canceled") {
      if (ours.planCode === planCode) {
        await noteProviderNextPlan(db, accountId, stripeProvider, null);
      } else {
        const current = await readPlan(db, ours.planCode);
        if (plan.priceMicros > (current?.priceMicros ?? 0n)) {
          // Dearer, and no paid invoice with it: switch now. Nothing is
          // collected by this step; the unearned rest of the running period
          // carries over, and the prorated charge is booked when its
          // invoice is reported paid.
          const periodStart = subscription.periodStart ?? now;
          await applyProviderPayment(db, {
            accountId,
            amountMicros: 0n,
            mode,
            periodEnd: subscription.periodEnd ?? addMonth(periodStart),
            periodStart,
            planCode,
            post,
            provider: stripeProvider,
            subscriptionId: subscription.id,
            transactionId: `switch:${subscription.id}:${priceId}:${periodStart.toISOString()}`,
          });
        } else {
          await noteProviderNextPlan(db, accountId, stripeProvider, planCode);
        }
      }
    }
  }

  if (subscription.status === "active" || subscription.status === "trialing") {
    await setProviderSubscriptionState(db, accountId, stripeProvider, { kind: "active" });
  } else if (subscription.status === "scheduled_cancel") {
    await setProviderSubscriptionState(db, accountId, stripeProvider, {
      cancelAt: subscription.cancelAt ?? subscription.periodEnd,
      kind: "scheduled",
    });
  } else if (subscription.status !== "incomplete" && !liveStatuses.has(subscription.status)) {
    // canceled, incomplete_expired, paused: Stripe no longer bills this.
    await setProviderSubscriptionState(db, accountId, stripeProvider, { kind: "canceled" });
  }
  // past_due / unpaid: Stripe is retrying the card. The plan stays while it
  // does, and the page says the payment failed.

  return { accountId, paymentApplied, planCode };
}

// ---- Refunds and disputes ----

/** The payment a charge paid, found by the charge or through its invoice. */
async function paymentForCharge(
  db: Database,
  config: StripeConfig,
  charge: { chargeId: string | null; paymentIntentId: string | null },
  fetchImpl?: StripeFetch,
) {
  if (charge.chargeId) {
    const [byRef] = await db
      .select()
      .from(providerPayments)
      .where(
        and(
          eq(providerPayments.provider, stripeProvider),
          eq(providerPayments.mode, config.mode),
          eq(providerPayments.kind, "payment"),
          eq(providerPayments.paymentRef, charge.chargeId),
        ),
      )
      .limit(1);
    if (byRef) {
      return { invoiceId: byRef.transactionId, payment: byRef };
    }
  }
  const invoiceId = await invoiceForCharge(config, charge, fetchImpl);
  if (!invoiceId) {
    return { invoiceId: null, payment: undefined };
  }
  return { invoiceId, payment: await paymentRow(db, config.mode, invoiceId) };
}

/** Money handed back (a refund, or a dispute lost), as the ledger takes it. */
async function handBack(
  db: Database,
  config: StripeConfig,
  input: {
    amountCents: number;
    charge: { chargeId: string | null; paymentIntentId: string | null };
    currency: string;
    details: Record<string, unknown>;
    id: string;
  },
  fetchImpl?: StripeFetch,
): Promise<{ accountId: string }> {
  const { invoiceId, payment } = await paymentForCharge(db, config, input.charge, fetchImpl);
  if (!invoiceId) {
    throw new BillingError("not_ours", 422, `${input.id} is for a charge no plan invoice paid`);
  }
  if (!payment) {
    // A plan invoice whose payment has not been applied yet (its webhook is
    // still on the way). Failing makes Stripe send this again later.
    throw new BillingError(
      "unknown_payment",
      422,
      `${input.id} is for invoice ${invoiceId}, whose payment is not recorded yet`,
    );
  }
  // The refund is tax included, like the payment was. Our share of it is in
  // the proportion the payment was ours; the rest is tax handed back.
  const paidWithTax = payment.amountMicros + payment.taxMicros;
  const refundMicros = centsToMicros(input.amountCents);
  const capped = paidWithTax > 0n && refundMicros > paidWithTax ? paidWithTax : refundMicros;
  const netMicros = paidWithTax > 0n ? (capped * payment.amountMicros) / paidWithTax : capped;
  const net = netMicros > payment.amountMicros ? payment.amountMicros : netMicros;
  await applyProviderRefund(db, {
    accountId: payment.accountId,
    amountMicros: net,
    currency: input.currency,
    details: input.details,
    mode: config.mode,
    paymentTransactionId: payment.transactionId,
    post: postsToLedger(config.mode),
    provider: stripeProvider,
    refundId: input.id,
    taxMicros: capped - net,
  });
  return { accountId: payment.accountId };
}

export async function applyRefund(
  db: Database,
  config: StripeConfig,
  refund: StripeRefundFacts,
  fetchImpl?: StripeFetch,
): Promise<{ accountId: string | null; pending: boolean }> {
  if (refund.status !== "succeeded") {
    // pending: its update arrives when it settles. failed / canceled: no
    // money moved.
    return { accountId: null, pending: refund.status === "pending" };
  }
  const result = await handBack(
    db,
    config,
    {
      amountCents: refund.amountCents,
      charge: { chargeId: refund.chargeId, paymentIntentId: refund.paymentIntentId },
      currency: refund.currency,
      details: { kind: "refund" },
      id: refund.id,
    },
    fetchImpl,
  );
  return { accountId: result.accountId, pending: false };
}

/**
 * A dispute (chargeback) has ended. Lost: the money is gone, which the books
 * take as a refund of the disputed amount. Either way Stripe's dispute fee,
 * net of any it gave back, is a cost.
 */
export async function applyDisputeClosed(
  db: Database,
  config: StripeConfig,
  dispute: StripeDisputeFacts,
  fetchImpl?: StripeFetch,
): Promise<{ accountId: string }> {
  const charge = { chargeId: dispute.chargeId, paymentIntentId: dispute.paymentIntentId };
  const { invoiceId, payment } = await paymentForCharge(db, config, charge, fetchImpl);
  if (!invoiceId) {
    throw new BillingError("not_ours", 422, `${dispute.id} is for a charge no plan invoice paid`);
  }
  if (!payment) {
    throw new BillingError(
      "unknown_payment",
      422,
      `${dispute.id} is for invoice ${invoiceId}, whose payment is not recorded yet`,
    );
  }
  if (dispute.status === "lost") {
    await handBack(
      db,
      config,
      {
        amountCents: dispute.amountCents,
        charge,
        currency: dispute.currency,
        details: { kind: "dispute", reason: dispute.reason },
        id: dispute.id,
      },
      fetchImpl,
    );
  }
  let micros = 0n;
  let unconverted = false;
  const settledAt = await settlementRateOf(db, config.mode, payment.paymentRef);
  for (const fee of dispute.fees) {
    const converted = feeMicrosIn(fee, payment.currency, settledAt);
    if (converted === null) {
      unconverted = true;
    } else {
      micros += converted;
    }
  }
  if (micros > 0n || unconverted) {
    await applyProviderFee(db, {
      accountId: payment.accountId,
      amountMicros: micros > 0n ? micros : 0n,
      currency: payment.currency,
      details: {
        dispute: dispute.id,
        settlement: dispute.fees.map((fee) => ({
          amount_minor: fee.amountMinor,
          currency: fee.currency,
          exchange_rate: fee.exchangeRate ?? settledAt?.exchangeRate ?? null,
        })),
        ...(unconverted ? { unconverted: true } : {}),
      },
      feeId: `${dispute.id}:fee`,
      mode: config.mode,
      paymentRef: payment.paymentRef,
      planCode: payment.planCode,
      post: payment.posted,
      provider: stripeProvider,
      subscriptionId: payment.subscriptionId,
    });
  }
  return { accountId: payment.accountId };
}

// ---- Webhooks ----

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Keys in Stripe's objects that carry the customer's own details. A webhook
// is kept for a person to read without them: the ids are enough to find the
// customer in Stripe's dashboard, which is where the details belong.
const personalKeys = new Set([
  "address",
  "billing_details",
  "customer_address",
  "customer_details",
  "customer_email",
  "customer_name",
  "customer_phone",
  "customer_shipping",
  "customer_tax_ids",
  "email",
  "name",
  "phone",
  "receipt_email",
  "shipping",
  "shipping_details",
]);

/** A payload as we keep it: no names, emails, addresses or phone numbers. */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 12) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactPayload(entry, depth + 1));
  }
  const object = asObject(value);
  if (!object) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (personalKeys.has(key)) {
      continue;
    }
    if (key === "payment_method_details") {
      // The card's brand and country stay; the last four digits, the
      // expiry and the fingerprint go.
      const card = asObject(asObject(entry)?.["card"]);
      result[key] = card ? { card: { brand: card["brand"] ?? null, country: card["country"] ?? null } } : null;
      continue;
    }
    result[key] = redactPayload(entry, depth + 1);
  }
  return result;
}

export interface WebhookResult {
  /** Something a person should look at now (a dispute was opened). */
  alert?: string | undefined;
  body: Record<string, unknown>;
  status: number;
}

/**
 * One webhook delivery. Signed with the endpoint's secret over the raw body;
 * recorded once under Stripe's event id, so a retry of something already
 * applied is acknowledged and nothing more. A delivery that fails to apply
 * answers 500, which makes Stripe send it again, and stays in
 * `provider_events` with its error for a person to read.
 *
 * Stripe does not promise order, and renders a notice in the endpoint's API
 * version, so a notice is a nudge: the subscription, invoice, refund or
 * dispute it names is read back from Stripe's API in our pinned version and
 * applied as it stands now.
 */
export async function handleWebhook(
  db: Database,
  config: StripeConfig,
  rawBody: string,
  signature: string | null,
  fetchImpl?: StripeFetch,
): Promise<WebhookResult> {
  const event = verifyWebhook(rawBody, signature, config.webhookSecret);
  if (!event) {
    return { body: { error: "invalid_signature" }, status: 401 };
  }
  const eventId = event.id;
  const eventType: string = event.type;
  const object = asObject((event.data as { object?: unknown } | undefined)?.object);
  if (!eventId || !eventType || !object) {
    return { body: { error: "invalid_event" }, status: 400 };
  }
  if (event.livemode !== (config.mode === "live")) {
    // A test event at a live deployment or the other way round: a
    // misconfigured endpoint, and nothing to apply.
    return { body: { ignored: true, ok: true, reason: "other_mode" }, status: 200 };
  }

  const [inserted] = await db
    .insert(providerEvents)
    .values({
      eventId,
      eventType,
      mode: config.mode,
      payload: redactPayload(event) as Record<string, unknown>,
      provider: stripeProvider,
    })
    .onConflictDoNothing()
    .returning({ id: providerEvents.id });
  if (!inserted) {
    const [existing] = await db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.provider, stripeProvider), eq(providerEvents.eventId, eventId)))
      .limit(1);
    if (existing?.processedAt) {
      return { body: { duplicate: true, ok: true }, status: 200 };
    }
    // Seen before and never applied: this delivery is the retry.
  }

  let accountId: string | null = null;
  let subscriptionId: string | null = null;
  let alert: string | undefined;
  try {
    if (eventType.startsWith("checkout.session.")) {
      const session = parseCheckoutSession(object);
      if (session?.mode === "subscription" && session.subscriptionId) {
        subscriptionId = session.subscriptionId;
        const subscription = await retrieveSubscription(config, session.subscriptionId, fetchImpl);
        accountId = (await applySubscription(db, config, subscription, { fetchImpl })).accountId;
      } else if (session && !session.accountId) {
        throw new BillingError("not_ours", 422, `Checkout ${session.id} was not started from this service`);
      }
    } else if (eventType.startsWith("customer.subscription.")) {
      const id = typeof object["id"] === "string" ? object["id"] : "";
      if (!id) {
        throw new BillingError("invalid_event", 422, "A subscription notice without a subscription id");
      }
      subscriptionId = id;
      const subscription = await retrieveSubscription(config, id, fetchImpl);
      accountId = (await applySubscription(db, config, subscription, { fetchImpl })).accountId;
    } else if (eventType.startsWith("invoice.")) {
      // The invoice as our API version shows it: the notice carries it in
      // the endpoint's version, which may lack the tax breakdown.
      const invoiceId = typeof object["id"] === "string" ? object["id"] : "";
      const invoice = invoiceId ? await retrieveInvoice(config, invoiceId, fetchImpl) : null;
      subscriptionId = invoice?.subscriptionId ?? null;
      if (!invoice || !subscriptionId) {
        throw new BillingError("not_ours", 422, "An invoice that no subscription made");
      }
      const subscription = await retrieveSubscription(config, subscriptionId, fetchImpl);
      accountId = (
        await applySubscription(db, config, subscription, {
          fetchImpl,
          invoice: invoice.paid ? invoice : null,
        })
      ).accountId;
    } else if (eventType === "refund.created" || eventType === "refund.updated") {
      const refundId = typeof object["id"] === "string" ? object["id"] : "";
      const refund = refundId ? await retrieveRefund(config, refundId, fetchImpl) : parseRefund(object);
      if (!refund) {
        throw new BillingError("invalid_event", 422, "A refund notice without a refund");
      }
      accountId = (await applyRefund(db, config, refund, fetchImpl)).accountId;
    } else if (eventType === "charge.dispute.created") {
      const dispute = parseDispute(object);
      alert = `Dispute ${dispute?.id ?? "?"} opened (${dispute?.reason ?? "no reason given"}): answer it in Stripe's dashboard before its deadline.`;
    } else if (eventType === "charge.dispute.closed") {
      const disputeId = typeof object["id"] === "string" ? object["id"] : "";
      const dispute = disputeId ? await retrieveDispute(config, disputeId, fetchImpl) : null;
      if (!dispute) {
        throw new BillingError("invalid_event", 422, "A dispute notice without a dispute");
      }
      accountId = (await applyDisputeClosed(db, config, dispute, fetchImpl)).accountId;
    }
    // Everything else is recorded and read by a person.
  } catch (error) {
    // Nothing of ours to apply, and asking for it again would not change
    // that: acknowledged, and kept with the reason.
    const ignored = error instanceof BillingError && error.code === "not_ours";
    await db
      .update(providerEvents)
      .set({
        accountId,
        error: error instanceof Error ? error.message.slice(0, 2000) : String(error),
        processedAt: ignored ? new Date() : null,
        subscriptionId,
      })
      .where(and(eq(providerEvents.provider, stripeProvider), eq(providerEvents.eventId, eventId)));
    if (ignored) {
      return { body: { ignored: true, ok: true }, status: 200 };
    }
    return {
      body: { error: error instanceof BillingError ? error.code : "processing_failed" },
      status: 500,
    };
  }
  await db
    .update(providerEvents)
    .set({ accountId, error: null, processedAt: new Date(), subscriptionId })
    .where(and(eq(providerEvents.provider, stripeProvider), eq(providerEvents.eventId, eventId)));
  return { alert, body: { ok: true }, status: 200 };
}

// ---- The return from checkout ----

/**
 * The browser is back from Stripe's checkout with the session's id. The id
 * proves nothing by itself: the session is read from Stripe's API, it must
 * be this account's, and the plan is granted from the subscription Stripe
 * then reports. Returns whether the plan is on the account yet (the webhook
 * finishes it otherwise).
 */
export async function handleCheckoutReturn(
  db: Database,
  config: StripeConfig,
  sessionId: string,
  accountId: string,
  fetchImpl?: StripeFetch,
): Promise<"active" | "failed" | "pending"> {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    throw new BillingError("invalid_session", 400, "This link did not come from checkout.");
  }
  const session = await retrieveCheckoutSession(config, sessionId, fetchImpl);
  if (session.accountId?.toLowerCase() !== accountId.toLowerCase()) {
    throw new BillingError("wrong_account", 403, "This purchase belongs to another account.");
  }
  if (session.status === "expired") {
    return "failed";
  }
  if (session.status !== "complete" || !session.subscriptionId) {
    return "pending";
  }
  const subscription = await retrieveSubscription(config, session.subscriptionId, fetchImpl);
  const applied = await applySubscription(db, config, subscription, { fetchImpl });
  const [ours] = await db
    .select({ planCode: subscriptions.planCode, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.accountId, applied.accountId))
    .limit(1);
  return ours && ours.status !== "canceled" && ours.planCode === applied.planCode
    ? "active"
    : "pending";
}

// ---- Changes the account asks for ----

/** Stop paying: the plan runs to the end of the period paid for. */
export async function cancelAtPeriodEnd(
  db: Database,
  config: StripeConfig,
  accountId: string,
  fetchImpl?: StripeFetch,
): Promise<boolean> {
  const row = await liveProviderSubscription(db, config.mode, accountId);
  if (!row) {
    return false;
  }
  if (row.status !== "scheduled_cancel") {
    const answer = await setCancelAtPeriodEnd(config, row.subscriptionId, true, fetchImpl);
    await applySubscription(db, config, answer, { fetchImpl });
  }
  return true;
}

/**
 * Move a paying account to another paid plan, or take back a cancellation.
 * A dearer plan starts now and Stripe charges the prorated difference; a
 * cheaper one is billed from the next renewal.
 */
export async function changePaidPlan(
  db: Database,
  config: StripeConfig,
  accountId: string,
  planCode: string,
  fetchImpl?: StripeFetch,
): Promise<void> {
  const row = await liveProviderSubscription(db, config.mode, accountId);
  if (!row) {
    throw new BillingError("checkout_required", 409, "Choose the plan at checkout first.");
  }
  if (row.status === "past_due" || row.status === "unpaid") {
    throw new BillingError(
      "payment_failed",
      409,
      "The last payment failed. Update your card under Manage billing first.",
    );
  }
  const price = await activePriceFor(db, config.mode, planCode);
  if (!price) {
    throw new BillingError("plan_not_for_sale", 404, "This plan cannot be bought here.");
  }
  // Stripe's subscription as it stands, not our copy: the item to change is
  // only known there, and an earlier upgrade may still be waiting.
  let current = await retrieveSubscription(config, row.subscriptionId, fetchImpl);
  if (current.pendingUpdate) {
    throw new BillingError(
      "payment_action_required",
      402,
      "An earlier change is waiting for its payment. Finish it, or wait a day for it to lapse.",
      current.latestInvoice?.hostedInvoiceUrl ? { url: current.latestInvoice.hostedInvoiceUrl } : {},
    );
  }
  const itemId = current.itemId;
  if (!itemId) {
    throw new BillingError("invalid_subscription", 409, "This subscription has no plan to change.");
  }
  if (current.status === "scheduled_cancel") {
    current = await setCancelAtPeriodEnd(config, row.subscriptionId, false, fetchImpl);
  }

  // What the account has PAID for this period is the plan it is on here,
  // which is not always the price Stripe holds: a downgrade moves Stripe's
  // price at once and ours at the renewal. Stripe prorates from its own
  // price, so charging from there would bill the difference a second time
  // when someone takes a downgrade back.
  const [ours] = await db
    .select({ planCode: subscriptions.planCode, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId))
    .limit(1);
  const paidCode = ours && ours.status !== "canceled" ? ours.planCode : row.planCode;
  const paid = paidCode ? await readPlan(db, paidCode) : undefined;
  const paidPrice = paidCode ? await activePriceFor(db, config.mode, paidCode) : undefined;
  const item = { id: row.subscriptionId, itemId };
  const key = (step: string) => `frameos-cloud-change:${row.subscriptionId}:${step}:${randomUUID()}`;

  if (price.priceMicros > (paid?.priceMicros ?? 0n)) {
    // A larger plan than the one paid for. Put Stripe back on the paid plan
    // first (nothing to charge: it is paid), so the prorated charge is the
    // difference from what they have, then move up.
    if (paidPrice && current.priceId !== paidPrice.productId) {
      current = await changeSubscriptionPrice(config, item, paidPrice.productId, "none", key("back"), fetchImpl);
    }
    current = await changeSubscriptionPrice(config, item, price.productId, "charge", key("up"), fetchImpl);
    await applySubscription(db, config, current, { fetchImpl });
    if (current.pendingUpdate) {
      // The card wants the customer (3-D Secure) or was declined. Stripe
      // holds the change until its invoice is paid; the invoice page is
      // where that happens.
      throw new BillingError(
        "payment_action_required",
        402,
        "Your bank needs to confirm this payment. The plan changes once it is paid.",
        current.latestInvoice?.hostedInvoiceUrl ? { url: current.latestInvoice.hostedInvoiceUrl } : {},
      );
    }
    return;
  }
  if (current.priceId !== price.productId) {
    // The plan paid for, or a smaller one: nothing is charged now. Stripe
    // bills the new price from the next renewal.
    current = await changeSubscriptionPrice(config, item, price.productId, "none", key("down"), fetchImpl);
  }
  await applySubscription(db, config, current, { fetchImpl });
}

/** Stripe's own page for invoices, the card and the billing details. */
/** One of the account's invoices, as the usage page lists them. */
export interface AccountInvoice {
  /** Still to pay, tax included: an invoice waiting for its payment. */
  amount_due_micros: string;
  created_at: string;
  currency: string;
  id: string;
  number: string | null;
  /** Stripe's PDF of the invoice. */
  pdf_url: string | null;
  /** Handed back so far, tax included: refunds and lost disputes. */
  refunded_micros: string;
  status: "due" | "not_paid" | "paid" | "partly_refunded" | "refunded";
  tax_micros: string;
  total_micros: string;
  /** Stripe's page for the invoice, where an open one is paid. */
  url: string | null;
}

/**
 * The account's invoices from Stripe, with what was refunded on each from
 * our own records (a refund is on the charge, which the invoice does not
 * show). Empty before the account has bought anything.
 */
export async function accountInvoices(
  db: Database,
  config: StripeConfig,
  accountId: string,
  fetchImpl?: StripeFetch,
): Promise<AccountInvoice[]> {
  const row = await latestProviderSubscription(db, config.mode, accountId);
  if (!row?.customerId) {
    return [];
  }
  const [invoices, payments] = await Promise.all([
    listCustomerInvoices(config, row.customerId, { fetchImpl }),
    db
      .select({
        amountMicros: providerPayments.amountMicros,
        kind: providerPayments.kind,
        paymentRef: providerPayments.paymentRef,
        taxMicros: providerPayments.taxMicros,
        transactionId: providerPayments.transactionId,
      })
      .from(providerPayments)
      .where(
        and(
          eq(providerPayments.provider, stripeProvider),
          eq(providerPayments.mode, config.mode),
          eq(providerPayments.accountId, accountId),
          inArray(providerPayments.kind, ["payment", "refund"]),
        ),
      ),
  ]);
  const chargeOf = new Map<string, string>();
  const refundedByCharge = new Map<string, bigint>();
  for (const payment of payments) {
    if (!payment.paymentRef) {
      continue;
    }
    if (payment.kind === "payment") {
      chargeOf.set(payment.transactionId, payment.paymentRef);
    } else {
      refundedByCharge.set(
        payment.paymentRef,
        (refundedByCharge.get(payment.paymentRef) ?? 0n) + payment.amountMicros + payment.taxMicros,
      );
    }
  }
  return invoices.map((invoice) => {
    const total = centsToMicros(invoice.totalCents);
    const charge = chargeOf.get(invoice.id);
    const refunded = charge ? (refundedByCharge.get(charge) ?? 0n) : 0n;
    const status: AccountInvoice["status"] =
      invoice.status === "open"
        ? "due"
        : invoice.status === "uncollectible"
          ? "not_paid"
          : refunded > 0n && refunded >= total
            ? "refunded"
            : refunded > 0n
              ? "partly_refunded"
              : "paid";
    return {
      amount_due_micros: centsToMicros(invoice.amountDueCents).toString(),
      created_at: invoice.created.toISOString(),
      currency: invoice.currency,
      id: invoice.id,
      number: invoice.number,
      pdf_url: invoice.pdfUrl,
      refunded_micros: refunded.toString(),
      status,
      tax_micros: centsToMicros(invoice.taxCents).toString(),
      total_micros: total.toString(),
      url: invoice.hostedInvoiceUrl,
    };
  });
}

export async function portalLink(
  db: Database,
  config: StripeConfig,
  accountId: string,
  returnUrl: string,
  fetchImpl?: StripeFetch,
): Promise<string> {
  const row = await latestProviderSubscription(db, config.mode, accountId);
  if (!row?.customerId) {
    throw new BillingError("no_billing_account", 404, "There is nothing to manage yet.");
  }
  return createPortalSession(config, { customerId: row.customerId, returnUrl }, fetchImpl);
}

// ---- Housekeeping ----

/**
 * Account deletion: end what Stripe would otherwise keep charging for.
 * Throws when Stripe cannot be told, and the deletion must then not go
 * ahead: a card billed monthly for an account that no longer exists is the
 * one outcome worse than a delete button that says "try again".
 */
export async function cancelForErasure(
  db: Database,
  setup: StripeSetup,
  accountId: string,
  fetchImpl?: StripeFetch,
): Promise<number> {
  const rows = await db
    .select()
    .from(providerSubscriptions)
    .where(
      and(
        eq(providerSubscriptions.accountId, accountId),
        inArray(providerSubscriptions.status, [...liveStatuses, "incomplete"]),
      ),
    );
  let canceled = 0;
  for (const row of rows) {
    if (row.provider !== stripeProvider || !setup.config || setup.config.mode !== row.mode) {
      if (row.mode === "test") {
        // No card behind it.
        continue;
      }
      throw new BillingError(
        "provider_unavailable",
        503,
        "This account has a paid plan that could not be cancelled right now.",
      );
    }
    await cancelSubscriptionNow(setup.config, row.subscriptionId, fetchImpl);
    await db
      .update(providerSubscriptions)
      .set({ canceledAt: new Date(), status: "canceled", updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, row.id));
    canceled += 1;
  }
  return canceled;
}

export interface ReconcileResult {
  checked: number;
  /** Payments whose charge and fee were booked tonight. */
  completed: number;
  failures: { error: unknown; subscriptionId: string }[];
  /** Subscriptions of the other mode that ran out and were ended here. */
  lapsed: number;
}

/**
 * The nightly safety net for a webhook that never arrived: read back every
 * subscription whose period has run out, or that has not been heard from in
 * a week, and apply what Stripe says. A renewal that was paid opens its
 * period; one that lapsed loses its plan. Then book the fees of the last
 * five weeks' payments that are still without one.
 */
export async function reconcileSubscriptions(
  db: Database,
  config: StripeConfig,
  options: { fetchImpl?: StripeFetch | undefined; limit?: number | undefined; now?: Date | undefined } = {},
): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const stale = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(providerSubscriptions)
    .where(
      and(
        eq(providerSubscriptions.provider, stripeProvider),
        eq(providerSubscriptions.mode, config.mode),
        ne(providerSubscriptions.status, "canceled"),
        ne(providerSubscriptions.status, "incomplete_expired"),
        or(
          isNull(providerSubscriptions.currentPeriodEnd),
          lt(providerSubscriptions.currentPeriodEnd, now),
          lt(providerSubscriptions.updatedAt, stale),
        ),
      ),
    )
    .orderBy(asc(providerSubscriptions.updatedAt))
    .limit(options.limit ?? 200);
  const result: ReconcileResult = { checked: 0, completed: 0, failures: [], lapsed: 0 };

  // A subscription from the mode this deployment has left (a test purchase,
  // once live), or from a provider it no longer uses, cannot be asked about
  // any more. It lapses at the end of the period it was granted for, like
  // one nobody renewed.
  const orphans = await db
    .select()
    .from(providerSubscriptions)
    .where(
      and(
        or(ne(providerSubscriptions.mode, config.mode), ne(providerSubscriptions.provider, stripeProvider)),
        ne(providerSubscriptions.status, "canceled"),
        or(
          isNull(providerSubscriptions.currentPeriodEnd),
          lt(providerSubscriptions.currentPeriodEnd, now),
        ),
      ),
    )
    .limit(options.limit ?? 200);
  for (const row of orphans) {
    await db
      .update(providerSubscriptions)
      .set({ canceledAt: now, status: "canceled", updatedAt: now })
      .where(eq(providerSubscriptions.id, row.id));
    if (!(await liveProviderSubscription(db, config.mode, row.accountId))) {
      await setProviderSubscriptionState(db, row.accountId, row.provider, { kind: "canceled" });
    }
    result.lapsed += 1;
  }

  for (const row of rows) {
    try {
      const subscription = await retrieveSubscription(config, row.subscriptionId, options.fetchImpl);
      await applySubscription(db, config, subscription, { fetchImpl: options.fetchImpl });
      result.checked += 1;
    } catch (error) {
      result.failures.push({ error, subscriptionId: row.subscriptionId });
    }
  }

  // Payments of the last five weeks without their charge or fee: Stripe had
  // not settled the charge when the payment was applied, or did not answer.
  const since = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);
  const payments = await db
    .select()
    .from(providerPayments)
    .where(
      and(
        eq(providerPayments.provider, stripeProvider),
        eq(providerPayments.mode, config.mode),
        eq(providerPayments.kind, "payment"),
        gt(providerPayments.occurredAt, since),
        gt(providerPayments.amountMicros, 0n),
      ),
    )
    .orderBy(asc(providerPayments.occurredAt))
    .limit(options.limit ?? 200);
  for (const payment of payments) {
    if (payment.paymentRef && (await feeRecorded(db, config.mode, payment.paymentRef))) {
      continue;
    }
    try {
      if (await completePaymentDetails(db, config, payment, options.fetchImpl)) {
        result.completed += 1;
      }
    } catch (error) {
      result.failures.push({ error, subscriptionId: payment.subscriptionId ?? payment.transactionId });
    }
  }
  return result;
}
