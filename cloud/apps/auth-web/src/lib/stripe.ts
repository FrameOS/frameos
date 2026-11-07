import Stripe from "stripe";

// Stripe, the payment provider behind the paid plans (cloud/docs/billing.md).
// This file is Stripe's API as the plans use it: the configuration, the
// calls, and what we read out of Stripe's objects. It knows nothing about
// our plans or our books; billing-provider.ts does the mapping.
//
// Stripe is a payment processor, not a merchant of record: Raaven BV sells
// the plan, Stripe Tax works out the VAT and adds it, and that tax is ours
// to remit. The ledger books it as owed (liability:sales_tax).
//
// Test and live are the same API with different keys, and each key carries
// its mode in its prefix (sk_test_, rk_live_, …). Which one this deployment
// talks to is stated twice on purpose, by STRIPE_MODE and by the key, and
// the two must agree: a live key under STRIPE_MODE=test is refused rather
// than quietly charging real cards.

export type StripeMode = "live" | "test";

export const stripeProvider = "stripe";

// The API version every call is made with, pinned so a Stripe-side default
// can never change the shape of what we read. It is the version this SDK
// release was generated for; moving it is a deliberate change with a test
// run against test mode (docs/billing.md "Upgrading the API version").
export const stripeApiVersion = "2026-09-30.endive";

/**
 * Whether a version is of our release: Stripe names a release after the
 * date ("endive") and its monthly versions only add to objects, so a webhook
 * endpoint on a later month of it sends what we read. The dashboard offers
 * an endpoint the latest month only.
 */
export function sameApiRelease(version: string): boolean {
  const release = (value: string) => /^\d{4}-\d{2}-\d{2}\.([a-z]+)$/.exec(value)?.[1] ?? null;
  const ours = release(stripeApiVersion);
  return version === stripeApiVersion || (ours !== null && release(version) === ours);
}

export interface StripeConfig {
  /** Let customers enter a promotion code at checkout. */
  allowPromotionCodes: boolean;
  /** Test only: another host for the API (the integration suite's stand-in). */
  apiBase: { host: string; port: number; protocol: "http" | "https" } | null;
  /** Stripe Tax adds the VAT / sales tax at checkout and on every renewal. */
  automaticTax: boolean;
  mode: StripeMode;
  secretKey: string;
  /** Whether a price includes the tax ("inclusive") or has it added on top. */
  taxBehavior: "exclusive" | "inclusive";
  /** Test mode only: every checkout gets its own customer on a test clock. */
  testClocks: boolean;
  webhookSecret: string;
}

export interface StripeSetup {
  config: StripeConfig | null;
  mode: StripeMode;
  /** Why `config` is null, in words an operator can act on. Null when unset. */
  problem: string | null;
}

type Env = Record<string, string | undefined>;

function flag(value: string | undefined, fallback: boolean): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function keyMode(key: string): StripeMode | null {
  const match = /^(?:sk|rk)_(test|live)_/.exec(key);
  return match ? (match[1] as StripeMode) : null;
}

export function stripeSetup(env: Env = process.env): StripeSetup {
  const rawMode = (env.STRIPE_MODE ?? "").trim().toLowerCase();
  const mode: StripeMode = rawMode === "live" ? "live" : "test";
  const secretKey = (env.STRIPE_SECRET_KEY ?? "").trim();
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!secretKey) {
    return { config: null, mode, problem: null };
  }
  if (rawMode && rawMode !== "live" && rawMode !== "test") {
    return { config: null, mode, problem: `STRIPE_MODE must be "test" or "live", not "${rawMode}".` };
  }
  const prefixMode = keyMode(secretKey);
  if (!prefixMode) {
    return {
      config: null,
      mode,
      problem:
        "STRIPE_SECRET_KEY is not a secret or restricted key (sk_… or rk_…). A publishable key (pk_…) cannot be used here.",
    };
  }
  if (prefixMode !== mode) {
    return {
      config: null,
      mode,
      problem:
        prefixMode === "live"
          ? "STRIPE_SECRET_KEY is a live key but STRIPE_MODE is test. Set STRIPE_MODE=live to take real payments."
          : "STRIPE_SECRET_KEY is a test key but STRIPE_MODE is live.",
    };
  }
  if (!webhookSecret.startsWith("whsec_")) {
    return {
      config: null,
      mode,
      problem: webhookSecret
        ? "STRIPE_WEBHOOK_SECRET is not a webhook signing secret (whsec_…)."
        : "STRIPE_WEBHOOK_SECRET is not set, so payments could not be confirmed.",
    };
  }
  const rawTaxBehavior = (env.STRIPE_TAX_BEHAVIOR ?? "").trim().toLowerCase();
  if (rawTaxBehavior && rawTaxBehavior !== "exclusive" && rawTaxBehavior !== "inclusive") {
    return {
      config: null,
      mode,
      problem: `STRIPE_TAX_BEHAVIOR must be "exclusive" or "inclusive", not "${rawTaxBehavior}".`,
    };
  }
  // Only test mode may be pointed elsewhere (the integration suite's
  // stand-in), and only test mode has test clocks.
  let apiBase: StripeConfig["apiBase"] = null;
  const override = mode === "test" ? (env.STRIPE_API_URL ?? "").trim() : "";
  if (override) {
    try {
      const url = new URL(override);
      apiBase = {
        host: url.hostname,
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
        protocol: url.protocol === "https:" ? "https" : "http",
      };
    } catch {
      return { config: null, mode, problem: `STRIPE_API_URL is not a URL: ${override}` };
    }
  }
  return {
    config: {
      allowPromotionCodes: flag(env.STRIPE_ALLOW_PROMOTION_CODES, false),
      apiBase,
      automaticTax: flag(env.STRIPE_AUTOMATIC_TAX, true),
      mode,
      secretKey,
      taxBehavior: rawTaxBehavior === "inclusive" ? "inclusive" : "exclusive",
      testClocks: mode === "test" && flag(env.STRIPE_TEST_CLOCKS, false),
      webhookSecret,
    },
    mode,
    problem: null,
  };
}

// ---- The client ----

export type StripeFetch = (input: string, init: RequestInit) => Promise<Response>;

/** A Stripe call that failed: Stripe said no, or did not answer. */
export class StripeApiError extends Error {
  /** Stripe's error code (`resource_missing`, `card_declined`), when it gave one. */
  readonly code: string | null;
  readonly status: number;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "StripeApiError";
    this.code = code;
    this.status = status;
  }
}

const clients = new Map<string, Stripe>();

/**
 * The SDK client for a configuration. `fetchImpl` routes every request
 * through another function (the integration suite's stand-in); without it
 * the client is shared per key.
 */
export function stripeClient(config: StripeConfig, fetchImpl?: StripeFetch): Stripe {
  const key = `${config.secretKey}|${config.apiBase ? JSON.stringify(config.apiBase) : ""}`;
  if (!fetchImpl) {
    const cached = clients.get(key);
    if (cached) {
      return cached;
    }
  }
  const client = new Stripe(config.secretKey, {
    apiVersion: stripeApiVersion,
    appInfo: { name: "FrameOS Cloud", url: "https://frameos.net" },
    // Stripe's own retry, with its idempotency keys, for a network failure
    // or a 409/5xx. A refusal (4xx) is final. The test stand-in answers at
    // once or not at all, so it is not retried.
    maxNetworkRetries: fetchImpl || config.apiBase ? 0 : 2,
    telemetry: false,
    timeout: 15_000,
    ...(fetchImpl ? { httpClient: Stripe.createFetchHttpClient(fetchImpl as typeof fetch) } : {}),
    ...(config.apiBase
      ? { host: config.apiBase.host, port: config.apiBase.port, protocol: config.apiBase.protocol }
      : {}),
  });
  if (!fetchImpl) {
    clients.set(key, client);
  }
  return client;
}

async function call<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StripeApiError) {
      throw error;
    }
    const raw = error as { code?: unknown; message?: unknown; statusCode?: unknown; type?: unknown };
    const status = typeof raw.statusCode === "number" ? raw.statusCode : 0;
    const code = typeof raw.code === "string" ? raw.code : null;
    const message = typeof raw.message === "string" ? raw.message : String(error);
    throw new StripeApiError(status, code, `Stripe ${what} failed${status ? ` (${status})` : ""}: ${message}`);
  }
}

// ---- What we read out of Stripe's objects ----

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value) {
    return value;
  }
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

function seconds(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
}

function metadataOf(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") {
        result[key] = entry;
      }
    }
  }
  return result;
}

/** The metadata keys a checkout of ours stamps on the session and the subscription. */
export const metadataKeys = {
  accountId: "frameos_account_id",
  planCode: "frameos_plan_code",
} as const;

export interface StripeInvoiceFacts {
  /** What was collected, tax included, in cents of `currency`. */
  amountPaidCents: number;
  billingReason: string | null;
  /** Upper case, like the ledger's currencies. */
  currency: string;
  customerId: string | null;
  hostedInvoiceUrl: string | null;
  id: string;
  number: string | null;
  paid: boolean;
  paidAt: Date | null;
  /** The bounds of the subscription line the payment bought. */
  periodEnd: Date | null;
  periodStart: Date | null;
  /** The price of that line: the plan the payment bought. */
  priceId: string | null;
  status: string | null;
  subscriptionId: string | null;
  /** The tax in what was collected, in cents. */
  taxCents: number;
}

export function parseInvoice(value: unknown): StripeInvoiceFacts | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const invoice = value as Partial<Stripe.Invoice>;
  if (typeof invoice.id !== "string" || !invoice.id) {
    return null;
  }
  const subscriptionId =
    idOf(invoice.parent?.subscription_details?.subscription) ??
    idOf((invoice as { subscription?: unknown }).subscription);
  // The line that bought the period: the largest charge for a price. On a
  // renewal it is the only line; on an upgrade's prorated invoice it is the
  // new plan's remaining time (the old plan's unused time is a credit).
  let line: Stripe.InvoiceLineItem | null = null;
  for (const entry of invoice.lines?.data ?? []) {
    if (entry.amount > 0 && (!line || entry.amount > line.amount)) {
      line = entry;
    }
  }
  if (!line) {
    line = invoice.lines?.data?.[0] ?? null;
  }
  const amountPaid = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
  const total = typeof invoice.total === "number" ? invoice.total : amountPaid;
  const totalTax = (invoice.total_taxes ?? []).reduce(
    (sum, tax) => sum + (typeof tax.amount === "number" ? tax.amount : 0),
    0,
  );
  // The tax share of what was collected. A customer balance can pay part of
  // an invoice, and only the cash part is in amount_paid.
  const taxCents =
    totalTax <= 0 || amountPaid <= 0
      ? 0
      : total > 0 && amountPaid < total
        ? Math.round((totalTax * amountPaid) / total)
        : Math.min(totalTax, amountPaid);
  return {
    amountPaidCents: amountPaid,
    billingReason: invoice.billing_reason ?? null,
    currency: (invoice.currency ?? "usd").toUpperCase(),
    customerId: idOf(invoice.customer),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    id: invoice.id,
    number: invoice.number ?? null,
    paid: invoice.status === "paid",
    paidAt: seconds(invoice.status_transitions?.paid_at),
    periodEnd: seconds(line?.period?.end),
    periodStart: seconds(line?.period?.start),
    priceId: idOf(line?.pricing?.price_details?.price),
    status: invoice.status ?? null,
    subscriptionId,
    taxCents,
  };
}

export interface StripeSubscriptionFacts {
  /** When the subscription will end, when a cancellation is scheduled. */
  cancelAt: Date | null;
  canceledAt: Date | null;
  customerId: string | null;
  id: string;
  itemId: string | null;
  /** Expanded when we asked for it; otherwise only its id is known. */
  latestInvoice: StripeInvoiceFacts | null;
  latestInvoiceId: string | null;
  metadata: Record<string, string>;
  /** An upgrade waits on a payment that needs the customer (3-D Secure). */
  pendingUpdate: boolean;
  periodEnd: Date | null;
  periodStart: Date | null;
  priceId: string | null;
  /**
   * Stripe's status, except that an active subscription with a cancellation
   * scheduled is "scheduled_cancel": the one state the plan pages tell apart.
   */
  status: string;
  stripeStatus: string;
}

export function parseSubscription(value: unknown): StripeSubscriptionFacts | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const subscription = value as Partial<Stripe.Subscription>;
  if (typeof subscription.id !== "string" || !subscription.id) {
    return null;
  }
  const item = subscription.items?.data?.[0] ?? null;
  const stripeStatus = subscription.status ?? "unknown";
  const cancelAt =
    seconds(subscription.cancel_at) ??
    (subscription.cancel_at_period_end ? seconds(item?.current_period_end) : null);
  const scheduled =
    (stripeStatus === "active" || stripeStatus === "trialing") &&
    (Boolean(subscription.cancel_at_period_end) || cancelAt !== null);
  const latest = subscription.latest_invoice;
  return {
    cancelAt,
    canceledAt: seconds(subscription.canceled_at) ?? seconds(subscription.ended_at),
    customerId: idOf(subscription.customer),
    id: subscription.id,
    itemId: item?.id ?? null,
    latestInvoice: latest && typeof latest === "object" ? parseInvoice(latest) : null,
    latestInvoiceId: idOf(latest),
    metadata: metadataOf(subscription.metadata),
    pendingUpdate: Boolean(subscription.pending_update),
    periodEnd: seconds(item?.current_period_end),
    periodStart: seconds(item?.current_period_start),
    priceId: idOf(item?.price),
    status: scheduled ? "scheduled_cancel" : stripeStatus,
    stripeStatus,
  };
}

// ---- Products and prices ----

export interface StripeProductSpec {
  description: string;
  /** Our name for the product (the plan group); found again by it. */
  key: string;
  name: string;
  /** Stripe Tax's product tax code. */
  taxCode: string;
}

/** The product a plan group is sold as, made or brought up to date. */
export async function ensureProduct(
  config: StripeConfig,
  spec: StripeProductSpec,
  fetchImpl?: StripeFetch,
): Promise<{ created: boolean; id: string }> {
  const stripe = stripeClient(config, fetchImpl);
  return call("products", async () => {
    const existing = (
      await stripe.products.list({ active: true, limit: 100 }).autoPagingToArray({ limit: 1000 })
    ).find((product) => product.metadata?.["frameos_cloud_group"] === spec.key);
    if (existing) {
      if (
        existing.name !== spec.name ||
        existing.description !== spec.description ||
        idOf(existing.tax_code) !== spec.taxCode
      ) {
        await stripe.products.update(existing.id, {
          description: spec.description,
          name: spec.name,
          tax_code: spec.taxCode,
        });
      }
      return { created: false, id: existing.id };
    }
    const created = await stripe.products.create({
      description: spec.description,
      metadata: { frameos_cloud_group: spec.key },
      name: spec.name,
      tax_code: spec.taxCode,
    });
    return { created: true, id: created.id };
  });
}

export interface StripePriceFacts {
  active: boolean;
  currency: string;
  id: string;
  interval: string | null;
  lookupKey: string | null;
  productId: string | null;
  taxBehavior: string | null;
  unitAmountCents: number | null;
}

function priceFacts(price: Stripe.Price): StripePriceFacts {
  return {
    active: price.active,
    currency: price.currency.toUpperCase(),
    id: price.id,
    interval: price.recurring?.interval ?? null,
    lookupKey: price.lookup_key ?? null,
    productId: idOf(price.product),
    taxBehavior: price.tax_behavior ?? null,
    unitAmountCents: price.unit_amount ?? null,
  };
}

/** The active prices that carry these lookup keys. */
export async function pricesByLookupKey(
  config: StripeConfig,
  lookupKeys: string[],
  fetchImpl?: StripeFetch,
): Promise<StripePriceFacts[]> {
  if (lookupKeys.length === 0) {
    return [];
  }
  const stripe = stripeClient(config, fetchImpl);
  return call("prices", async () => {
    const result: StripePriceFacts[] = [];
    // Stripe takes at most ten lookup keys per list call.
    for (let index = 0; index < lookupKeys.length; index += 10) {
      const page = await stripe.prices.list({
        active: true,
        limit: 100,
        lookup_keys: lookupKeys.slice(index, index + 10),
      });
      result.push(...page.data.map(priceFacts));
    }
    return result;
  });
}

export async function createMonthlyPrice(
  config: StripeConfig,
  input: {
    currency: string;
    lookupKey: string;
    metadata: Record<string, string>;
    nickname: string;
    productId: string;
    unitAmountCents: number;
  },
  fetchImpl?: StripeFetch,
): Promise<StripePriceFacts> {
  const stripe = stripeClient(config, fetchImpl);
  return call("price creation", async () =>
    priceFacts(
      await stripe.prices.create({
        currency: input.currency.toLowerCase(),
        lookup_key: input.lookupKey,
        metadata: input.metadata,
        nickname: input.nickname,
        product: input.productId,
        recurring: { interval: "month", interval_count: 1 },
        tax_behavior: config.taxBehavior,
        // A lookup key names one price. Should another price hold it (made
        // by hand, or by a sync whose row was lost), it moves here.
        transfer_lookup_key: true,
        unit_amount: input.unitAmountCents,
      }),
    ),
  );
}

// ---- The customer portal ----

export interface PortalSpec {
  headline: string;
  privacyPolicyUrl: string;
  returnUrl: string;
  termsOfServiceUrl: string;
}

/**
 * The portal configuration the plans use: invoices, the card, the billing
 * details, and cancelling at the end of the period. Changing plans is not
 * in it: that goes through our own page, which knows what was paid for.
 */
export async function ensurePortalConfiguration(
  config: StripeConfig,
  spec: PortalSpec,
  fetchImpl?: StripeFetch,
): Promise<{ created: boolean; id: string }> {
  const stripe = stripeClient(config, fetchImpl);
  const settings = {
    business_profile: {
      headline: spec.headline,
      privacy_policy_url: spec.privacyPolicyUrl,
      terms_of_service_url: spec.termsOfServiceUrl,
    },
    default_return_url: spec.returnUrl,
    features: {
      customer_update: {
        allowed_updates: ["address", "email", "name", "tax_id"] as Array<
          "address" | "email" | "name" | "tax_id"
        >,
        enabled: true,
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        cancellation_reason: {
          enabled: true,
          options: [
            "too_expensive",
            "missing_features",
            "switched_service",
            "unused",
            "other",
          ] as Array<
            | "customer_service"
            | "low_quality"
            | "missing_features"
            | "other"
            | "switched_service"
            | "too_complex"
            | "too_expensive"
            | "unused"
          >,
        },
        enabled: true,
        mode: "at_period_end" as const,
        proration_behavior: "none" as const,
      },
      subscription_update: { enabled: false },
    },
  };
  return call("portal configuration", async () => {
    const existing = (
      await stripe.billingPortal.configurations.list({ active: true, limit: 100 })
    ).data.find((entry) => entry.metadata?.["frameos_cloud"] === "plans");
    if (existing) {
      await stripe.billingPortal.configurations.update(existing.id, settings);
      return { created: false, id: existing.id };
    }
    const created = await stripe.billingPortal.configurations.create({
      ...settings,
      metadata: { frameos_cloud: "plans" },
    });
    return { created: true, id: created.id };
  });
}

let portalConfigurationCache: { id: string; key: string } | null = null;

export async function createPortalSession(
  config: StripeConfig,
  input: { customerId: string; returnUrl: string },
  fetchImpl?: StripeFetch,
): Promise<string> {
  const stripe = stripeClient(config, fetchImpl);
  return call("portal", async () => {
    // Our configuration when Sync plans has made one, else the account's
    // default (which Stripe requires to have been saved once in its
    // dashboard).
    let configuration: string | undefined;
    if (portalConfigurationCache?.key === config.secretKey) {
      configuration = portalConfigurationCache.id;
    } else {
      const ours = (
        await stripe.billingPortal.configurations.list({ active: true, limit: 100 })
      ).data.find((entry) => entry.metadata?.["frameos_cloud"] === "plans");
      if (ours && !fetchImpl) {
        portalConfigurationCache = { id: ours.id, key: config.secretKey };
      }
      configuration = ours?.id;
    }
    const session = await stripe.billingPortal.sessions.create({
      ...(configuration ? { configuration } : {}),
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return session.url;
  });
}

// ---- Checkout ----

export interface CheckoutInput {
  accountId: string;
  cancelUrl: string;
  /** A customer of ours from an earlier subscription, reused. */
  customerId: string | null;
  email: string;
  /** Sent as Stripe's Idempotency-Key, so a retried request opens one session. */
  idempotencyKey: string;
  planCode: string;
  priceId: string;
  /** May contain Stripe's `{CHECKOUT_SESSION_ID}` placeholder. */
  successUrl: string;
}

export async function createCheckoutSession(
  config: StripeConfig,
  input: CheckoutInput,
  fetchImpl?: StripeFetch,
): Promise<{ id: string; url: string }> {
  const stripe = stripeClient(config, fetchImpl);
  const metadata = {
    [metadataKeys.accountId]: input.accountId,
    [metadataKeys.planCode]: input.planCode,
  };
  return call("checkout", async () => {
    let customer = input.customerId;
    if (!customer && config.testClocks) {
      // Test mode with test clocks: a fresh customer on its own clock, so
      // a renewal (and a failed one) can be watched by advancing the clock
      // in Stripe's dashboard instead of waiting a month.
      const clock = await stripe.testHelpers.testClocks.create({
        frozen_time: Math.floor(Date.now() / 1000),
        name: `FrameOS Cloud ${input.planCode} ${input.accountId.slice(0, 8)}`,
      });
      customer = (
        await stripe.customers.create({
          email: input.email,
          metadata: { [metadataKeys.accountId]: input.accountId },
          test_clock: clock.id,
        })
      ).id;
    }
    const session = await stripe.checkout.sessions.create(
      {
        // Our prices are in one currency and so are the books; Stripe's
        // localized prices would arrive as a payment in another.
        adaptive_pricing: { enabled: false },
        allow_promotion_codes: config.allowPromotionCodes,
        automatic_tax: { enabled: config.automaticTax },
        // A full address: the invoice is a VAT invoice, and Stripe Tax
        // places the customer by it.
        billing_address_collection: "required",
        cancel_url: input.cancelUrl,
        client_reference_id: input.accountId,
        ...(customer
          ? {
              customer,
              customer_update: { address: "auto" as const, name: "auto" as const },
            }
          : { customer_email: input.email }),
        line_items: [{ price: input.priceId, quantity: 1 }],
        locale: "auto",
        metadata,
        mode: "subscription",
        subscription_data: { metadata },
        success_url: input.successUrl,
        // A business enters its VAT number and is invoiced under the
        // reverse charge.
        tax_id_collection: { enabled: true },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (!session.url) {
      throw new StripeApiError(0, null, "Stripe made a checkout without a URL");
    }
    return { id: session.id, url: session.url };
  });
}

export interface StripeCheckoutFacts {
  accountId: string | null;
  customerId: string | null;
  id: string;
  mode: string | null;
  paymentStatus: string | null;
  status: string | null;
  subscriptionId: string | null;
}

export function parseCheckoutSession(value: unknown): StripeCheckoutFacts | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const session = value as Partial<Stripe.Checkout.Session>;
  if (typeof session.id !== "string" || !session.id) {
    return null;
  }
  const metadata = metadataOf(session.metadata);
  return {
    accountId: metadata[metadataKeys.accountId] ?? session.client_reference_id ?? null,
    customerId: idOf(session.customer),
    id: session.id,
    mode: session.mode ?? null,
    paymentStatus: session.payment_status ?? null,
    status: session.status ?? null,
    subscriptionId: idOf(session.subscription),
  };
}

export async function retrieveCheckoutSession(
  config: StripeConfig,
  sessionId: string,
  fetchImpl?: StripeFetch,
): Promise<StripeCheckoutFacts> {
  const stripe = stripeClient(config, fetchImpl);
  return call("checkout lookup", async () => {
    const facts = parseCheckoutSession(await stripe.checkout.sessions.retrieve(sessionId));
    if (!facts) {
      throw new StripeApiError(0, null, `Stripe returned no checkout for ${sessionId}`);
    }
    return facts;
  });
}

// ---- Invoices ----

/**
 * An invoice as this API version shows it. A webhook carries the invoice in
 * the endpoint's own API version, which may be years older than ours (an
 * old invoice has no `total_taxes`), so the payment is always read back.
 */
export async function retrieveInvoice(
  config: StripeConfig,
  invoiceId: string,
  fetchImpl?: StripeFetch,
): Promise<StripeInvoiceFacts> {
  const stripe = stripeClient(config, fetchImpl);
  return call("invoice lookup", async () => {
    const facts = parseInvoice(await stripe.invoices.retrieve(invoiceId));
    if (!facts) {
      throw new StripeApiError(0, null, `Stripe returned no invoice for ${invoiceId}`);
    }
    return facts;
  });
}

/** An invoice as the customer's list of them shows it. */
export interface StripeInvoiceListing {
  /** Still to pay, in cents: an open invoice's remaining amount. */
  amountDueCents: number;
  created: Date;
  /** Upper case, like the ledger's currencies. */
  currency: string;
  hostedInvoiceUrl: string | null;
  id: string;
  number: string | null;
  pdfUrl: string | null;
  status: string | null;
  /** The tax in the total, in cents. */
  taxCents: number;
  /** Tax included, in cents. */
  totalCents: number;
}

/**
 * A customer's invoices, newest first: the ones a person can open. Drafts
 * are not sent yet and a void invoice was never owed (an upgrade whose
 * payment was abandoned), so neither is listed.
 */
export async function listCustomerInvoices(
  config: StripeConfig,
  customerId: string,
  options: { fetchImpl?: StripeFetch | undefined; limit?: number } = {},
): Promise<StripeInvoiceListing[]> {
  const stripe = stripeClient(config, options.fetchImpl);
  return call("invoice list", async () => {
    const page = await stripe.invoices.list({ customer: customerId, limit: options.limit ?? 24 });
    return page.data
      .filter((invoice) => invoice.status !== "draft" && invoice.status !== "void")
      .map((invoice) => ({
        amountDueCents: invoice.status === "open" ? (invoice.amount_remaining ?? invoice.amount_due ?? 0) : 0,
        created: new Date((invoice.created ?? 0) * 1000),
        currency: (invoice.currency ?? "usd").toUpperCase(),
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        id: invoice.id ?? "",
        number: invoice.number ?? null,
        pdfUrl: invoice.invoice_pdf ?? null,
        status: invoice.status ?? null,
        taxCents: (invoice.total_taxes ?? []).reduce(
          (sum, tax) => sum + (typeof tax.amount === "number" ? tax.amount : 0),
          0,
        ),
        totalCents: invoice.total ?? 0,
      }))
      .filter((invoice) => invoice.id);
  });
}

// ---- Subscriptions ----

export async function retrieveSubscription(
  config: StripeConfig,
  subscriptionId: string,
  fetchImpl?: StripeFetch,
): Promise<StripeSubscriptionFacts> {
  const stripe = stripeClient(config, fetchImpl);
  return call("subscription lookup", async () => {
    const facts = parseSubscription(
      await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] }),
    );
    if (!facts) {
      throw new StripeApiError(0, null, `Stripe returned no subscription for ${subscriptionId}`);
    }
    return facts;
  });
}

/**
 * Move a subscription to another price. "charge": the prorated difference
 * is invoiced and collected now, and the change waits for that payment
 * (it applies only once paid). "none": nothing now; the new price is billed
 * from the next renewal.
 */
export async function changeSubscriptionPrice(
  config: StripeConfig,
  subscription: { id: string; itemId: string },
  priceId: string,
  proration: "charge" | "none",
  idempotencyKey: string,
  fetchImpl?: StripeFetch,
): Promise<StripeSubscriptionFacts> {
  const stripe = stripeClient(config, fetchImpl);
  return call("plan change", async () => {
    const facts = parseSubscription(
      await stripe.subscriptions.update(
        subscription.id,
        {
          expand: ["latest_invoice"],
          items: [{ id: subscription.itemId, price: priceId }],
          ...(proration === "charge"
            ? { payment_behavior: "pending_if_incomplete" as const, proration_behavior: "always_invoice" as const }
            : { proration_behavior: "none" as const }),
        },
        { idempotencyKey },
      ),
    );
    if (!facts) {
      throw new StripeApiError(0, null, `Stripe returned no subscription for ${subscription.id}`);
    }
    return facts;
  });
}

export async function setCancelAtPeriodEnd(
  config: StripeConfig,
  subscriptionId: string,
  cancel: boolean,
  fetchImpl?: StripeFetch,
): Promise<StripeSubscriptionFacts> {
  const stripe = stripeClient(config, fetchImpl);
  return call(cancel ? "cancellation" : "resumption", async () => {
    const facts = parseSubscription(
      await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: cancel,
        expand: ["latest_invoice"],
      }),
    );
    if (!facts) {
      throw new StripeApiError(0, null, `Stripe returned no subscription for ${subscriptionId}`);
    }
    return facts;
  });
}

/** End a subscription now, with no refund and no final invoice. */
export async function cancelSubscriptionNow(
  config: StripeConfig,
  subscriptionId: string,
  fetchImpl?: StripeFetch,
): Promise<void> {
  const stripe = stripeClient(config, fetchImpl);
  await call("cancellation", async () => {
    try {
      await stripe.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false });
    } catch (error) {
      // Already ended at Stripe: what we wanted.
      const raw = error as { code?: unknown; statusCode?: unknown };
      if (raw.statusCode === 404 || raw.code === "resource_missing") {
        return;
      }
      throw error;
    }
  });
}

// ---- Money after the payment: fees, refunds, disputes ----

export interface StripeFeeFacts {
  /** Stripe's fee in the balance's currency, in its minor unit. */
  amountMinor: number;
  /** The balance transaction the fee is on: the fee's id. */
  balanceTransactionId: string;
  /** The balance's currency (the account's settlement currency), upper case. */
  currency: string;
  /** Payment currency to settlement currency, when they differ (Stripe's rate). */
  exchangeRate: number | null;
}

function feeFacts(value: unknown): StripeFeeFacts | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const transaction = value as Partial<Stripe.BalanceTransaction>;
  if (typeof transaction.id !== "string" || typeof transaction.fee !== "number") {
    return null;
  }
  return {
    amountMinor: transaction.fee,
    balanceTransactionId: transaction.id,
    currency: (transaction.currency ?? "usd").toUpperCase(),
    exchangeRate: typeof transaction.exchange_rate === "number" ? transaction.exchange_rate : null,
  };
}

export interface StripeChargeFacts {
  chargeId: string;
  /** Null while Stripe has not settled the charge into the balance yet. */
  fee: StripeFeeFacts | null;
  paymentIntentId: string | null;
}

/** The charge that paid an invoice, and the fee Stripe kept on it. */
export async function invoiceCharge(
  config: StripeConfig,
  invoiceId: string,
  fetchImpl?: StripeFetch,
): Promise<StripeChargeFacts | null> {
  const stripe = stripeClient(config, fetchImpl);
  return call("invoice payment lookup", async () => {
    const payments = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 10 });
    const paid = payments.data.find((entry) => entry.status === "paid") ?? payments.data[0];
    if (!paid) {
      return null;
    }
    const paymentIntentId = idOf(paid.payment.payment_intent);
    let chargeId = idOf(paid.payment.charge);
    let fee: StripeFeeFacts | null = null;
    if (paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge.balance_transaction"],
      });
      const charge = intent.latest_charge;
      if (charge && typeof charge === "object") {
        chargeId = charge.id;
        fee = feeFacts(charge.balance_transaction);
      } else {
        chargeId = chargeId ?? idOf(charge);
      }
    } else if (chargeId) {
      const charge = await stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] });
      fee = feeFacts(charge.balance_transaction);
    }
    return chargeId ? { chargeId, fee, paymentIntentId } : null;
  });
}

/** The invoice a charge paid, for a refund whose payment we cannot place. */
export async function invoiceForCharge(
  config: StripeConfig,
  charge: { chargeId: string | null; paymentIntentId: string | null },
  fetchImpl?: StripeFetch,
): Promise<string | null> {
  const stripe = stripeClient(config, fetchImpl);
  return call("invoice lookup", async () => {
    const payment = charge.paymentIntentId
      ? { payment_intent: charge.paymentIntentId, type: "payment_intent" as const }
      : null;
    if (!payment) {
      return null;
    }
    const list = await stripe.invoicePayments.list({ limit: 1, payment });
    return idOf(list.data[0]?.invoice);
  });
}

export interface StripeRefundFacts {
  amountCents: number;
  chargeId: string | null;
  currency: string;
  id: string;
  paymentIntentId: string | null;
  status: string | null;
}

export function parseRefund(value: unknown): StripeRefundFacts | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const refund = value as Partial<Stripe.Refund>;
  if (typeof refund.id !== "string" || typeof refund.amount !== "number") {
    return null;
  }
  return {
    amountCents: refund.amount,
    chargeId: idOf(refund.charge),
    currency: (refund.currency ?? "usd").toUpperCase(),
    id: refund.id,
    paymentIntentId: idOf(refund.payment_intent),
    status: refund.status ?? null,
  };
}

export async function retrieveRefund(
  config: StripeConfig,
  refundId: string,
  fetchImpl?: StripeFetch,
): Promise<StripeRefundFacts> {
  const stripe = stripeClient(config, fetchImpl);
  return call("refund lookup", async () => {
    const facts = parseRefund(await stripe.refunds.retrieve(refundId));
    if (!facts) {
      throw new StripeApiError(0, null, `Stripe returned no refund for ${refundId}`);
    }
    return facts;
  });
}

export interface StripeDisputeFacts {
  amountCents: number;
  chargeId: string | null;
  currency: string;
  /** Every balance movement the dispute made; their fees sum to its cost. */
  fees: StripeFeeFacts[];
  id: string;
  paymentIntentId: string | null;
  reason: string | null;
  status: string | null;
}

export function parseDispute(value: unknown): StripeDisputeFacts | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const dispute = value as Partial<Stripe.Dispute>;
  if (typeof dispute.id !== "string" || typeof dispute.amount !== "number") {
    return null;
  }
  return {
    amountCents: dispute.amount,
    chargeId: idOf(dispute.charge),
    currency: (dispute.currency ?? "usd").toUpperCase(),
    fees: (dispute.balance_transactions ?? [])
      .map((entry) => feeFacts(entry))
      .filter((entry): entry is StripeFeeFacts => entry !== null),
    id: dispute.id,
    paymentIntentId: idOf(dispute.payment_intent),
    reason: dispute.reason ?? null,
    status: dispute.status ?? null,
  };
}

export async function retrieveDispute(
  config: StripeConfig,
  disputeId: string,
  fetchImpl?: StripeFetch,
): Promise<StripeDisputeFacts> {
  const stripe = stripeClient(config, fetchImpl);
  return call("dispute lookup", async () => {
    const facts = parseDispute(await stripe.disputes.retrieve(disputeId));
    if (!facts) {
      throw new StripeApiError(0, null, `Stripe returned no dispute for ${disputeId}`);
    }
    return facts;
  });
}

// ---- The account's own setup ----

export interface StripeAccountChecks {
  /** Stripe Tax: "active" once the head office address and a registration are in. */
  taxStatus: string | null;
  /** The webhook endpoints pointing at `webhookUrl`, and what they are missing. */
  webhook: {
    /** The API version the endpoint renders events in, when it is not ours. */
    apiVersion: string | null;
    enabled: boolean;
    found: boolean;
    missingEvents: string[];
  };
}

/** The events the webhook route acts on. The endpoint must send them all. */
export const webhookEvents = [
  "charge.dispute.closed",
  "charge.dispute.created",
  "checkout.session.async_payment_failed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "invoice.paid",
  "invoice.payment_action_required",
  "invoice.payment_failed",
  "refund.created",
  "refund.updated",
] as const;

/**
 * What an operator needs to know before taking payments: whether Stripe
 * Tax is on, and whether a webhook endpoint for this deployment sends every
 * event the route acts on. Read-only; a key without the permission to read
 * one of them reports it as unknown.
 */
export async function accountChecks(
  config: StripeConfig,
  webhookUrl: string,
  fetchImpl?: StripeFetch,
): Promise<StripeAccountChecks> {
  const stripe = stripeClient(config, fetchImpl);
  let taxStatus: string | null = null;
  try {
    taxStatus = (await stripe.tax.settings.retrieve()).status ?? null;
  } catch {
    taxStatus = null;
  }
  const webhook: StripeAccountChecks["webhook"] = {
    apiVersion: null,
    enabled: false,
    found: false,
    missingEvents: [...webhookEvents],
  };
  try {
    const endpoints = (await stripe.webhookEndpoints.list({ limit: 100 })).data.filter(
      (endpoint) => endpoint.url.replace(/\/+$/, "") === webhookUrl.replace(/\/+$/, ""),
    );
    if (endpoints.length > 0) {
      webhook.found = true;
      const enabled = endpoints.filter((endpoint) => endpoint.status === "enabled");
      webhook.enabled = enabled.length > 0;
      const sent = new Set(enabled.flatMap((endpoint) => endpoint.enabled_events));
      webhook.missingEvents = sent.has("*")
        ? []
        : webhookEvents.filter((event) => !sent.has(event));
      // Every object a notice names is read back in our version, so another
      // release works; it is reported so the endpoint can be brought in line.
      const versions = [...new Set(enabled.map((endpoint) => endpoint.api_version ?? "account default"))];
      webhook.apiVersion = versions.find((version) => !sameApiRelease(version)) ?? null;
    }
  } catch {
    // Unknown: a restricted key without "Webhook Endpoints: read".
  }
  return { taxStatus, webhook };
}

// ---- Webhooks ----

/**
 * A webhook delivery, checked against the endpoint's signing secret: the
 * `Stripe-Signature` header signs the raw body with a timestamp, and one
 * older than five minutes is refused as a replay. Null when it does not
 * verify.
 */
export function verifyWebhook(
  rawBody: string,
  signature: string | null,
  webhookSecret: string,
): Stripe.Event | null {
  if (!signature) {
    return null;
  }
  try {
    return Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret, 300);
  } catch {
    return null;
  }
}

/** A signature header for a body, as Stripe would send it (tests only). */
export function signWebhookForTests(rawBody: string, webhookSecret: string, timestamp?: number): string {
  return Stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret: webhookSecret,
    ...(timestamp ? { timestamp } : {}),
  });
}

export function centsToMicros(cents: number): bigint {
  return BigInt(Math.round(cents)) * 10_000n;
}
