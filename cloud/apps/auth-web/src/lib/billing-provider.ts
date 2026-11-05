import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lt, ne, or } from "drizzle-orm";
import {
  accounts,
  billingPlans,
  providerEvents,
  providerPayments,
  providerProducts,
  providerSubscriptions,
  subscriptions,
  type createDb,
} from "@frameos-cloud/db";
import {
  addMonth,
  applyProviderPayment,
  applyProviderRefund,
  fallbackPaygPlan,
  listPlans,
  noteProviderNextPlan,
  paygPlanCode,
  readPlan,
  setProviderSubscriptionState,
} from "@frameos-cloud/ledger";
import {
  cancelSubscription,
  centsToMicros,
  changeSubscriptionProduct,
  createCheckout,
  createMonthlyProduct,
  createPortalLink,
  creemProvider,
  getSubscription,
  idOf,
  listProducts,
  metadataOf,
  parseSubscription,
  parseTransaction,
  resumeSubscription,
  verifyRedirectSignature,
  verifyWebhookSignature,
  type CreemConfig,
  type CreemFetch,
  type CreemMode,
  type CreemSetup,
  type CreemSubscription,
  type CreemTransaction,
} from "./creem";
import { catalogLimits, planRowFor, selfServeStops } from "./plan-catalog";
import { limitsForPlan } from "./usage";

// Paid plans, collected by the payment provider (cloud/docs/billing.md).
//
// One rule runs through this file: what an account is entitled to changes
// only on what the provider says happened. A checkout that returns, a
// webhook and the nightly reconcile all hand the same thing to
// `applySubscription` (the provider's subscription as it stands now), and
// that function is idempotent, so the three may arrive in any order and any
// number of times.
//
//  - A payment puts the account on the plan it paid for and opens the
//    period (the ledger's applyProviderPayment).
//  - A dearer product without a payment notice yet (an upgrade whose charge
//    is reported separately) switches the plan at once; the charge is
//    booked when it arrives.
//  - A cheaper product is where the account goes at the next renewal. It
//    keeps what it paid for until then.
//  - A cancellation runs to the end of the period paid for.

type Database = ReturnType<typeof createDb>;

export class BillingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "BillingError";
    this.code = code;
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
 * production database must not invent revenue. CREEM_TEST_LEDGER=1 posts
 * them anyway, for a development database.
 */
export function postsToLedger(mode: CreemMode, env: Env = process.env): boolean {
  return mode === "live" || flag(env.CREEM_TEST_LEDGER);
}

/**
 * Who may check out. In live mode, everyone. In test mode a plan can be had
 * with a test card, so on a production build it is the operators' alone.
 */
export function checkoutOpenTo(
  mode: CreemMode,
  superadmin: boolean,
  env: Env = process.env,
): boolean {
  if (mode === "live" || superadmin) {
    return true;
  }
  return env.NODE_ENV !== "production" || flag(env.CREEM_TEST_OPEN);
}

// Statuses in which the provider still bills, or will again.
const liveStatuses = new Set(["active", "trialing", "past_due", "unpaid", "scheduled_cancel"]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Plans and products ----

export interface PlanSyncResult {
  code: string;
  /** Made at the provider by this run. */
  created: boolean;
  productId: string;
}

// The product a stop is sold as. Its name is also how a product that is
// already in the store (made by another deployment's sync, or by hand) is
// recognised, so it must stay a function of the plan alone.
function productNameFor(groupName: string, usd: number): string {
  return `FrameOS Cloud ${groupName} ($${usd}/month)`;
}

/**
 * Give every self-serve stop its billing_plans row and its product at the
 * provider, in the provider's current mode. The provider's own list is the
 * truth about which products exist:
 *
 *  - the product our row names is still there and active: left alone;
 *  - the store already has an active monthly product with the stop's name
 *    and price (another deployment synced first, or the row's product was
 *    lost): that one is adopted, so two deployments on one store sell the
 *    same products;
 *  - otherwise one is created.
 *
 * Safe to run again at any time.
 */
export async function syncPlans(
  db: Database,
  config: CreemConfig,
  fetchImpl?: CreemFetch,
): Promise<PlanSyncResult[]> {
  const plans = await listPlans(db);
  const freePlan = plans.find((plan) => plan.code === paygPlanCode) ?? fallbackPaygPlan;
  const free = limitsForPlan(freePlan);
  const inStore = (await listProducts(config, fetchImpl)).filter(
    (product) => product.status === "active",
  );
  const results: PlanSyncResult[] = [];
  for (const entry of selfServeStops()) {
    // AI costs the same on every plan, so a paid stop prices it as Free does.
    const row = planRowFor(free, entry, freePlan.marginBasisPoints);
    await db
      .insert(billingPlans)
      .values(row)
      .onConflictDoUpdate({
        set: {
          description: row.description,
          entitlements: row.entitlements,
          name: row.name,
          public: row.public,
          sortOrder: row.sortOrder,
          updatedAt: new Date(),
        },
        target: billingPlans.code,
      });

    const [existing] = await db
      .select()
      .from(providerProducts)
      .where(
        and(
          eq(providerProducts.provider, creemProvider),
          eq(providerProducts.mode, config.mode),
          eq(providerProducts.planCode, entry.code),
          eq(providerProducts.active, true),
        ),
      )
      .orderBy(desc(providerProducts.createdAt))
      .limit(1);
    const priceCents = entry.stop.usd * 100;
    if (
      existing &&
      existing.priceMicros === row.priceMicros &&
      inStore.some((product) => product.id === existing.productId)
    ) {
      results.push({ code: entry.code, created: false, productId: existing.productId });
      continue;
    }
    const name = productNameFor(entry.groupName, entry.stop.usd);
    const adopted = inStore.find(
      (product) =>
        product.name === name &&
        product.priceCents === priceCents &&
        product.currency === "USD" &&
        product.billingType === "recurring" &&
        product.billingPeriod === "every-month",
    );
    const limits = catalogLimits(free, entry.stop);
    const productId =
      adopted?.id ??
      (await createMonthlyProduct(
        config,
        {
          description: `FrameOS Cloud ${entry.groupName} plan: up to ${limits.frames} frames and ${entry.stop.usd} times the free plan's storage for photos, private scenes, backups and frame logs. Billed monthly, cancel any time.`,
          // Unique per creation: the store's own list was checked a moment
          // ago, and a key that named only the plan would hand back the
          // very product that is gone.
          idempotencyKey: `frameos-cloud:${config.mode}:${entry.code}:${randomUUID()}`,
          name,
          priceCents,
        },
        fetchImpl,
      ));
    await db.transaction(async (tx) => {
      await tx
        .update(providerProducts)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(providerProducts.provider, creemProvider),
            eq(providerProducts.mode, config.mode),
            eq(providerProducts.planCode, entry.code),
          ),
        );
      await tx
        .insert(providerProducts)
        .values({
          mode: config.mode,
          planCode: entry.code,
          priceMicros: row.priceMicros,
          productId,
          provider: creemProvider,
        })
        .onConflictDoUpdate({
          set: { active: true, planCode: entry.code, priceMicros: row.priceMicros, updatedAt: new Date() },
          target: [providerProducts.provider, providerProducts.mode, providerProducts.productId],
        });
    });
    results.push({ code: entry.code, created: !adopted, productId });
  }
  return results;
}

/** The plan codes this visitor can take at checkout right now. */
export async function purchasablePlanCodes(
  db: Database,
  setup: CreemSetup,
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
        eq(providerProducts.provider, creemProvider),
        eq(providerProducts.mode, setup.config.mode),
        eq(providerProducts.active, true),
      ),
    );
  return new Set(rows.map((row) => row.planCode));
}

async function activeProductFor(db: Database, mode: CreemMode, planCode: string) {
  const [row] = await db
    .select()
    .from(providerProducts)
    .where(
      and(
        eq(providerProducts.provider, creemProvider),
        eq(providerProducts.mode, mode),
        eq(providerProducts.planCode, planCode),
        eq(providerProducts.active, true),
      ),
    )
    .orderBy(desc(providerProducts.createdAt))
    .limit(1);
  return row;
}

async function planCodeForProduct(db: Database, mode: CreemMode, productId: string) {
  const [row] = await db
    .select({ planCode: providerProducts.planCode })
    .from(providerProducts)
    .where(
      and(
        eq(providerProducts.provider, creemProvider),
        eq(providerProducts.mode, mode),
        eq(providerProducts.productId, productId),
      ),
    )
    .limit(1);
  return row?.planCode;
}

// ---- The account's subscription at the provider ----

type ProviderSubscriptionRow = typeof providerSubscriptions.$inferSelect;

/** The newest subscription the provider holds for the account in this mode. */
export async function latestProviderSubscription(
  db: Database,
  mode: CreemMode,
  accountId: string,
): Promise<ProviderSubscriptionRow | undefined> {
  const [row] = await db
    .select()
    .from(providerSubscriptions)
    .where(
      and(
        eq(providerSubscriptions.provider, creemProvider),
        eq(providerSubscriptions.mode, mode),
        eq(providerSubscriptions.accountId, accountId),
      ),
    )
    .orderBy(desc(providerSubscriptions.createdAt))
    .limit(1);
  return row;
}

async function liveProviderSubscription(db: Database, mode: CreemMode, accountId: string) {
  const row = await latestProviderSubscription(db, mode, accountId);
  return row && liveStatuses.has(row.status) ? row : undefined;
}

export interface BillingSummary {
  /** A card can be charged here: the provider is set up for this visitor. */
  checkout: boolean;
  /** The provider's customer portal can be opened. */
  manage: boolean;
  mode: CreemMode | null;
  subscription: {
    cancel_at: string | null;
    /** The last charge failed and the provider is retrying. */
    past_due: boolean;
    plan_code: string | null;
    renews_at: string | null;
    status: string;
  } | null;
}

export async function billingSummary(
  db: Database,
  setup: CreemSetup,
  accountId: string,
  superadmin: boolean,
): Promise<BillingSummary> {
  if (!setup.config) {
    return { checkout: false, manage: false, mode: null, subscription: null };
  }
  const row = await latestProviderSubscription(db, setup.config.mode, accountId);
  const live = row && liveStatuses.has(row.status) ? row : undefined;
  const scheduled = live?.status === "scheduled_cancel";
  return {
    checkout: checkoutOpenTo(setup.config.mode, superadmin),
    manage: Boolean(row?.customerId),
    mode: setup.config.mode,
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
  config: CreemConfig,
  input: { accountId: string; email: string; planCode: string; returnUrl: string },
  fetchImpl?: CreemFetch,
): Promise<{ url: string }> {
  const product = await activeProductFor(db, config.mode, input.planCode);
  if (!product) {
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
  const checkout = await createCheckout(
    config,
    {
      customer: previous?.customerId ? { id: previous.customerId } : { email: input.email },
      // How the payment finds its account again, in the webhook and on return.
      metadata: { account_id: input.accountId, plan_code: input.planCode },
      productId: product.productId,
      requestId: randomUUID(),
      successUrl: input.returnUrl,
    },
    fetchImpl,
  );
  return { url: checkout.url };
}

// ---- Applying the provider's state ----

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

/**
 * Make our side agree with the provider's subscription as it stands.
 * `transaction` is the payment a notice carried beside the subscription
 * (a completed checkout's order), when the subscription itself names none.
 */
export async function applySubscription(
  db: Database,
  config: CreemConfig,
  subscription: CreemSubscription,
  hint: { transaction?: CreemTransaction | null | undefined } = {},
): Promise<ApplyResult> {
  const mode = config.mode;
  const [known] = await db
    .select()
    .from(providerSubscriptions)
    .where(
      and(
        eq(providerSubscriptions.provider, creemProvider),
        eq(providerSubscriptions.mode, mode),
        eq(providerSubscriptions.subscriptionId, subscription.id),
      ),
    )
    .limit(1);

  // The account a subscription belongs to is fixed by the checkout we made
  // for it. Once recorded it does not move, whatever later metadata says.
  let accountId = known?.accountId;
  if (!accountId) {
    const claimed = subscription.metadata["account_id"] ?? "";
    if (!claimed) {
      // Not made by our checkout: something else sold in the same store.
      throw new BillingError(
        "not_ours",
        422,
        `Subscription ${subscription.id} was not started from this service`,
      );
    }
    if (!uuidPattern.test(claimed) || !(await accountExists(db, claimed))) {
      throw new BillingError(
        "unknown_account",
        422,
        `Subscription ${subscription.id} names no account of ours`,
      );
    }
    accountId = claimed.toLowerCase();
  }

  const productId = subscription.productId ?? known?.productId ?? null;
  const planCode = productId ? await planCodeForProduct(db, mode, productId) : undefined;
  if (!productId || !planCode) {
    throw new BillingError(
      "unknown_product",
      422,
      `Subscription ${subscription.id} is for a product no plan is mapped to (${productId ?? "none"})`,
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
      productId,
      provider: creemProvider,
      status: subscription.status,
      subscriptionId: subscription.id,
    })
    .onConflictDoUpdate({
      set: {
        canceledAt: subscription.canceledAt,
        planCode,
        productId,
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

  const periodStart = subscription.periodStart ?? known?.currentPeriodStart ?? now;
  const periodEnd = subscription.periodEnd ?? known?.currentPeriodEnd ?? addMonth(periodStart);
  const post = postsToLedger(mode);

  let paymentApplied = false;
  const transaction = subscription.lastTransaction ?? hint.transaction ?? null;
  if (transaction && transaction.status === "paid") {
    const result = await applyProviderPayment(db, {
      accountId,
      amountMicros: centsToMicros(Math.max(0, transaction.amountPaidCents - transaction.taxCents)),
      currency: transaction.currency,
      mode,
      occurredAt: transaction.occurredAt ?? undefined,
      periodEnd,
      periodStart,
      planCode,
      post,
      provider: creemProvider,
      subscriptionId: subscription.id,
      taxMicros: centsToMicros(transaction.taxCents),
      transactionId: transaction.id,
    });
    paymentApplied = result.applied;
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
    if (ours && ours.provider === creemProvider && ours.status !== "canceled") {
      if (ours.planCode === planCode) {
        await noteProviderNextPlan(db, accountId, creemProvider, null);
      } else {
        const current = await readPlan(db, ours.planCode);
        if (plan.priceMicros > (current?.priceMicros ?? 0n)) {
          // Dearer, and no payment notice with it: switch now. Nothing is
          // collected by this step; the unearned rest of the running period
          // carries over, and the prorated charge is booked when it is
          // reported.
          await applyProviderPayment(db, {
            accountId,
            amountMicros: 0n,
            mode,
            periodEnd,
            periodStart,
            planCode,
            post,
            provider: creemProvider,
            subscriptionId: subscription.id,
            transactionId: `switch:${subscription.id}:${productId}:${periodStart.toISOString()}`,
          });
        } else {
          await noteProviderNextPlan(db, accountId, creemProvider, planCode);
        }
      }
    }
  }

  if (subscription.status === "active" || subscription.status === "trialing") {
    await setProviderSubscriptionState(db, accountId, creemProvider, { kind: "active" });
  } else if (subscription.status === "scheduled_cancel") {
    await setProviderSubscriptionState(db, accountId, creemProvider, {
      cancelAt: subscription.periodEnd,
      kind: "scheduled",
    });
  } else if (!liveStatuses.has(subscription.status)) {
    // canceled, paused, expired: the provider no longer bills this.
    await setProviderSubscriptionState(db, accountId, creemProvider, { kind: "canceled" });
  }
  // past_due / unpaid: the provider is retrying the card. The plan stays
  // while it does, and the page says the payment failed.

  return { accountId, paymentApplied, planCode };
}

// ---- Webhooks ----

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A payload as we keep it: the customer reduced to their id and country. */
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
    const nested = asObject(entry);
    if (key === "customer" && nested) {
      result[key] = { country: nested["country"] ?? null, id: nested["id"] ?? null };
    } else if (key === "custom_fields" || key === "license_keys") {
      continue;
    } else {
      result[key] = redactPayload(entry, depth + 1);
    }
  }
  return result;
}

async function applyRefundNotice(
  db: Database,
  config: CreemConfig,
  object: Record<string, unknown>,
): Promise<{ accountId: string | null }> {
  const refundId = typeof object["id"] === "string" ? object["id"] : "";
  const transaction = parseTransaction(object["transaction"]);
  const transactionId =
    transaction?.id ?? (typeof object["transaction"] === "string" ? object["transaction"] : "");
  const refundCents =
    typeof object["refund_amount"] === "number" ? Math.round(object["refund_amount"]) : 0;
  if (!refundId || !transactionId) {
    throw new BillingError("invalid_event", 422, "A refund notice without a refund or transaction id");
  }
  const [payment] = await db
    .select()
    .from(providerPayments)
    .where(
      and(
        eq(providerPayments.provider, creemProvider),
        eq(providerPayments.mode, config.mode),
        eq(providerPayments.kind, "payment"),
        eq(providerPayments.transactionId, transactionId),
      ),
    )
    .limit(1);
  if (!payment) {
    throw new BillingError(
      "unknown_payment",
      422,
      `Refund ${refundId} is for a payment we never recorded (${transactionId})`,
    );
  }
  // The refund is tax included, like the payment was. Our share of it is in
  // the proportion the payment was ours.
  const paidWithTax = payment.amountMicros + payment.taxMicros;
  const refundMicros = centsToMicros(refundCents);
  const netMicros =
    paidWithTax > 0n ? (refundMicros * payment.amountMicros) / paidWithTax : refundMicros;
  await applyProviderRefund(db, {
    accountId: payment.accountId,
    amountMicros: netMicros > payment.amountMicros ? payment.amountMicros : netMicros,
    currency: payment.currency,
    mode: config.mode,
    paymentTransactionId: transactionId,
    post: postsToLedger(config.mode),
    provider: creemProvider,
    refundId,
    taxMicros: refundMicros - netMicros,
  });
  return { accountId: payment.accountId };
}

export interface WebhookResult {
  body: Record<string, unknown>;
  status: number;
}

/**
 * One webhook delivery. Signed with the webhook secret over the raw body;
 * recorded once under the provider's event id, so a retry of something
 * already applied is acknowledged and nothing more. A delivery that fails to
 * apply answers 500, which makes the provider send it again, and stays in
 * `provider_events` with its error for a person to read.
 */
export async function handleWebhook(
  db: Database,
  config: CreemConfig,
  rawBody: string,
  signature: string | null,
): Promise<WebhookResult> {
  if (!verifyWebhookSignature(rawBody, signature, config.webhookSecret)) {
    return { body: { error: "invalid_signature" }, status: 401 };
  }
  let event: Record<string, unknown> | null = null;
  try {
    event = asObject(JSON.parse(rawBody));
  } catch {
    event = null;
  }
  const eventId = typeof event?.["id"] === "string" ? event["id"] : "";
  const eventType = typeof event?.["eventType"] === "string" ? event["eventType"] : "";
  const object = asObject(event?.["object"]);
  if (!event || !eventId || !eventType || !object) {
    return { body: { error: "invalid_event" }, status: 400 };
  }

  const [inserted] = await db
    .insert(providerEvents)
    .values({
      eventId,
      eventType,
      mode: config.mode,
      payload: redactPayload(event) as Record<string, unknown>,
      provider: creemProvider,
    })
    .onConflictDoNothing()
    .returning({ id: providerEvents.id });
  if (!inserted) {
    const [existing] = await db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.provider, creemProvider), eq(providerEvents.eventId, eventId)))
      .limit(1);
    if (existing?.processedAt) {
      return { body: { duplicate: true, ok: true }, status: 200 };
    }
    // Seen before and never applied: this delivery is the retry.
  }

  let accountId: string | null = null;
  let subscriptionId: string | null = null;
  try {
    if (eventType === "checkout.completed") {
      const subscription = parseSubscription(object["subscription"]);
      if (subscription) {
        const order = asObject(object["order"]);
        const transactionId = typeof order?.["transaction"] === "string" ? order["transaction"] : null;
        const merged: CreemSubscription = {
          ...subscription,
          // The checkout carries what its nested subscription may leave out.
          customerId: subscription.customerId ?? idOf(object["customer"]),
          metadata: { ...metadataOf(object["metadata"]), ...subscription.metadata },
          productId: subscription.productId ?? idOf(object["product"]),
        };
        const applied = await applySubscription(db, config, merged, {
          transaction:
            order && transactionId ? parseTransaction({ ...order, id: transactionId }) : null,
        });
        accountId = applied.accountId;
        subscriptionId = subscription.id;
      }
      // A one-time checkout has no subscription and nothing here sells one.
    } else if (eventType.startsWith("subscription.")) {
      const subscription = parseSubscription(object);
      if (!subscription) {
        throw new BillingError("invalid_event", 422, "A subscription notice without a subscription id");
      }
      subscriptionId = subscription.id;
      accountId = (await applySubscription(db, config, subscription)).accountId;
    } else if (eventType === "refund.created") {
      accountId = (await applyRefundNotice(db, config, object)).accountId;
    }
    // Everything else (disputes, credits) is recorded and read by a person.
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
      .where(and(eq(providerEvents.provider, creemProvider), eq(providerEvents.eventId, eventId)));
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
    .where(and(eq(providerEvents.provider, creemProvider), eq(providerEvents.eventId, eventId)));
  return { body: { ok: true }, status: 200 };
}

// ---- The return from checkout ----

/**
 * The browser is back from the provider's checkout. The redirect is signed
 * with our API key, so a forged one names nothing; and the plan is granted
 * from what the provider's API then says about the subscription, never from
 * the redirect itself. Returns whether the plan is on the account yet (the
 * webhook finishes it otherwise).
 */
export async function handleCheckoutReturn(
  db: Database,
  config: CreemConfig,
  params: URLSearchParams,
  accountId: string,
  fetchImpl?: CreemFetch,
): Promise<"active" | "pending"> {
  if (!verifyRedirectSignature(params, config.apiKey)) {
    throw new BillingError("invalid_signature", 400, "This link did not come from checkout.");
  }
  const subscriptionId = params.get("subscription_id");
  if (!subscriptionId) {
    return "pending";
  }
  const subscription = await getSubscription(config, subscriptionId, fetchImpl);
  if (subscription.metadata["account_id"]?.toLowerCase() !== accountId.toLowerCase()) {
    throw new BillingError("wrong_account", 403, "This purchase belongs to another account.");
  }
  const applied = await applySubscription(db, config, subscription);
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

async function refreshed(
  db: Database,
  config: CreemConfig,
  subscriptionId: string,
  answer: CreemSubscription | null,
  fetchImpl?: CreemFetch,
) {
  // The answer to a change does not always carry the payment it caused, so
  // read the subscription back and apply that.
  let subscription = answer;
  try {
    subscription = await getSubscription(config, subscriptionId, fetchImpl);
  } catch (error) {
    if (!subscription) {
      throw error;
    }
  }
  if (subscription) {
    await applySubscription(db, config, subscription);
  }
}

/** Stop paying: the plan runs to the end of the period paid for. */
export async function cancelAtPeriodEnd(
  db: Database,
  config: CreemConfig,
  accountId: string,
  fetchImpl?: CreemFetch,
): Promise<boolean> {
  const row = await liveProviderSubscription(db, config.mode, accountId);
  if (!row) {
    return false;
  }
  if (row.status !== "scheduled_cancel") {
    const answer = await cancelSubscription(config, row.subscriptionId, "scheduled", fetchImpl);
    await refreshed(db, config, row.subscriptionId, answer, fetchImpl);
  }
  return true;
}

/**
 * Move a paying account to another paid plan, or take back a cancellation.
 * A dearer plan starts now and the provider charges the prorated difference;
 * a cheaper one is billed from the next renewal.
 */
export async function changePaidPlan(
  db: Database,
  config: CreemConfig,
  accountId: string,
  planCode: string,
  fetchImpl?: CreemFetch,
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
  const product = await activeProductFor(db, config.mode, planCode);
  if (!product) {
    throw new BillingError("plan_not_for_sale", 404, "This plan cannot be bought here.");
  }
  let answer: CreemSubscription | null = null;
  if (row.status === "scheduled_cancel") {
    answer = await resumeSubscription(config, row.subscriptionId, fetchImpl);
  }

  // What the account has PAID for this period is the plan it is on here,
  // which is not always the product the provider holds: a downgrade moves
  // the provider's product at once and ours at the renewal. The provider
  // prorates from its own product, so charging from there would bill the
  // difference a second time when someone takes a downgrade back.
  const [ours] = await db
    .select({ planCode: subscriptions.planCode, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId))
    .limit(1);
  const paidCode = ours && ours.status !== "canceled" ? ours.planCode : row.planCode;
  const paid = paidCode ? await readPlan(db, paidCode) : undefined;
  const paidProduct = paidCode ? await activeProductFor(db, config.mode, paidCode) : undefined;
  let providerProductId = row.productId;

  if (product.priceMicros > (paid?.priceMicros ?? 0n)) {
    // A larger plan than the one paid for. Put the provider back on the
    // paid plan first (nothing to charge: it is paid), so the prorated
    // charge is the difference from what they have, then move up.
    if (paidProduct && providerProductId !== paidProduct.productId) {
      answer = await changeSubscriptionProduct(
        config,
        row.subscriptionId,
        paidProduct.productId,
        "none",
        fetchImpl,
      );
      providerProductId = paidProduct.productId;
    }
    answer = await changeSubscriptionProduct(
      config,
      row.subscriptionId,
      product.productId,
      "charge",
      fetchImpl,
    );
  } else if (providerProductId !== product.productId) {
    // The plan paid for, or a smaller one: nothing is charged now. The
    // provider bills the new price from the next renewal.
    answer = await changeSubscriptionProduct(
      config,
      row.subscriptionId,
      product.productId,
      "none",
      fetchImpl,
    );
  }
  await refreshed(db, config, row.subscriptionId, answer, fetchImpl);
}

/** The provider's own page for invoices and the card on file. */
export async function portalLink(
  db: Database,
  config: CreemConfig,
  accountId: string,
  fetchImpl?: CreemFetch,
): Promise<string> {
  const row = await latestProviderSubscription(db, config.mode, accountId);
  if (!row?.customerId) {
    throw new BillingError("no_billing_account", 404, "There is nothing to manage yet.");
  }
  return createPortalLink(config, row.customerId, fetchImpl);
}

// ---- Housekeeping ----

/**
 * Account deletion: end what the provider would otherwise keep charging
 * for. Throws when the provider cannot be told, and the deletion must then
 * not go ahead: a card billed monthly for an account that no longer exists
 * is the one outcome worse than a delete button that says "try again".
 */
export async function cancelForErasure(
  db: Database,
  setup: CreemSetup,
  accountId: string,
  fetchImpl?: CreemFetch,
): Promise<number> {
  const rows = await db
    .select()
    .from(providerSubscriptions)
    .where(
      and(
        eq(providerSubscriptions.provider, creemProvider),
        eq(providerSubscriptions.accountId, accountId),
      ),
    );
  let canceled = 0;
  for (const row of rows) {
    if (!liveStatuses.has(row.status)) {
      continue;
    }
    if (!setup.config || setup.config.mode !== row.mode) {
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
    await cancelSubscription(setup.config, row.subscriptionId, "immediate", fetchImpl);
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
  failures: { error: unknown; subscriptionId: string }[];
  /** Subscriptions of the other mode that ran out and were ended here. */
  lapsed: number;
}

/**
 * The nightly safety net for a webhook that never arrived: read back every
 * subscription whose period has run out, or that has not been heard from in
 * a week, and apply what the provider says. A renewal that was paid opens
 * its period; one that lapsed loses its plan.
 */
export async function reconcileSubscriptions(
  db: Database,
  config: CreemConfig,
  options: { fetchImpl?: CreemFetch | undefined; limit?: number | undefined; now?: Date | undefined } = {},
): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const stale = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(providerSubscriptions)
    .where(
      and(
        eq(providerSubscriptions.provider, creemProvider),
        eq(providerSubscriptions.mode, config.mode),
        ne(providerSubscriptions.status, "canceled"),
        or(
          isNull(providerSubscriptions.currentPeriodEnd),
          lt(providerSubscriptions.currentPeriodEnd, now),
          lt(providerSubscriptions.updatedAt, stale),
        ),
      ),
    )
    .orderBy(asc(providerSubscriptions.updatedAt))
    .limit(options.limit ?? 200);
  const result: ReconcileResult = { checked: 0, failures: [], lapsed: 0 };

  // A subscription from the mode this deployment has left (a test purchase,
  // once live) cannot be asked about any more. It lapses at the end of the
  // period it was granted for, like one nobody renewed.
  const orphans = await db
    .select()
    .from(providerSubscriptions)
    .where(
      and(
        eq(providerSubscriptions.provider, creemProvider),
        ne(providerSubscriptions.mode, config.mode),
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
      await setProviderSubscriptionState(db, row.accountId, creemProvider, { kind: "canceled" });
    }
    result.lapsed += 1;
  }

  for (const row of rows) {
    try {
      const subscription = await getSubscription(config, row.subscriptionId, options.fetchImpl);
      await applySubscription(db, config, subscription);
      result.checked += 1;
    } catch (error) {
      result.failures.push({ error, subscriptionId: row.subscriptionId });
    }
  }
  return result;
}
