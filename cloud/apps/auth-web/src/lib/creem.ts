import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Creem (creem.io), the payment provider behind the paid plans: a merchant
// of record that sells the plan, charges the card and remits the tax
// (cloud/docs/billing.md). This file is its HTTP API and its two
// signatures, and knows nothing about our plans or books.
//
// Test and live are two separate Creem environments with their own hosts,
// keys, products and webhook secrets. Which one this deployment talks to is
// stated twice on purpose, by CREEM_MODE and by the key's own prefix, and
// the two must agree: a live key under CREEM_MODE=test is refused rather
// than quietly charging real cards.

export type CreemMode = "live" | "test";

export const creemProvider = "creem";

const liveBaseUrl = "https://api.creem.io";
const testBaseUrl = "https://test-api.creem.io";
const testKeyPrefix = "creem_test_";

export interface CreemConfig {
  apiKey: string;
  baseUrl: string;
  mode: CreemMode;
  webhookSecret: string;
}

export interface CreemSetup {
  config: CreemConfig | null;
  mode: CreemMode;
  /** Why `config` is null, in words an operator can act on. Null when unset. */
  problem: string | null;
}

type Env = Record<string, string | undefined>;

export function creemSetup(env: Env = process.env): CreemSetup {
  const rawMode = (env.CREEM_MODE ?? "").trim().toLowerCase();
  const mode: CreemMode = rawMode === "live" ? "live" : "test";
  const apiKey = (env.CREEM_API_KEY ?? "").trim();
  const webhookSecret = (env.CREEM_WEBHOOK_SECRET ?? "").trim();
  if (!apiKey) {
    return { config: null, mode, problem: null };
  }
  if (rawMode && rawMode !== "live" && rawMode !== "test") {
    return { config: null, mode, problem: `CREEM_MODE must be "test" or "live", not "${rawMode}".` };
  }
  const testKey = apiKey.startsWith(testKeyPrefix);
  if (mode === "test" && !testKey) {
    return {
      config: null,
      mode,
      problem: "CREEM_API_KEY is a live key but CREEM_MODE is test. Set CREEM_MODE=live to take real payments.",
    };
  }
  if (mode === "live" && testKey) {
    return {
      config: null,
      mode,
      problem: "CREEM_API_KEY is a test key but CREEM_MODE is live.",
    };
  }
  if (!webhookSecret) {
    return {
      config: null,
      mode,
      problem: "CREEM_WEBHOOK_SECRET is not set, so payments could not be confirmed.",
    };
  }
  // Only the test environment may be pointed elsewhere (the local stand-in,
  // scripts/creem-fake.mjs).
  const override = mode === "test" ? (env.CREEM_API_URL ?? "").trim().replace(/\/+$/, "") : "";
  return {
    config: {
      apiKey,
      baseUrl: override || (mode === "live" ? liveBaseUrl : testBaseUrl),
      mode,
      webhookSecret,
    },
    mode,
    problem: null,
  };
}

export class CreemError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CreemError";
    this.status = status;
  }
}

type Json = Record<string, unknown>;

export type CreemFetch = (input: string, init: RequestInit) => Promise<Response>;

interface RequestOptions {
  body?: Json | undefined;
  fetchImpl?: CreemFetch | undefined;
  idempotencyKey?: string | undefined;
  query?: Record<string, string> | undefined;
}

const requestTimeoutMs = 15_000;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

async function creemRequest(
  config: CreemConfig,
  method: "GET" | "POST",
  path: string,
  options: RequestOptions = {},
): Promise<Json> {
  const url = new URL(`${config.baseUrl}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-api-key": config.apiKey,
  };
  if (options.body) {
    headers["content-type"] = "application/json";
  }
  if (options.idempotencyKey) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url.toString(), {
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      headers,
      method,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new CreemError(0, `Creem did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let parsed: Json | null = null;
  try {
    parsed = asObject(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = parsed?.["message"];
    const detail = Array.isArray(message) ? message.join("; ") : typeof message === "string" ? message : text.slice(0, 200);
    throw new CreemError(response.status, `Creem ${method} ${path} failed (${response.status}): ${detail}`);
  }
  if (!parsed) {
    throw new CreemError(response.status, `Creem ${method} ${path} returned no JSON object`);
  }
  return parsed;
}

// ---- What we read out of Creem's objects ----

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function date(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

// Creem hands a nested object back as the object or as its bare id.
export function idOf(value: unknown): string | null {
  return text(value) ?? text(asObject(value)?.["id"]);
}

export function metadataOf(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(asObject(value) ?? {})) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

export interface CreemTransaction {
  /** What the customer paid, tax included, in cents. */
  amountPaidCents: number;
  currency: string;
  id: string;
  occurredAt: Date | null;
  status: string;
  taxCents: number;
}

export interface CreemSubscription {
  canceledAt: Date | null;
  customerId: string | null;
  id: string;
  lastTransaction: CreemTransaction | null;
  metadata: Record<string, string>;
  periodEnd: Date | null;
  periodStart: Date | null;
  productId: string | null;
  status: string;
}

export function parseTransaction(value: unknown): CreemTransaction | null {
  const raw = asObject(value);
  const id = text(raw?.["id"]);
  if (!raw || !id) {
    return null;
  }
  const tax = integer(raw["tax_amount"]) ?? 0;
  // `amount` is before tax and `amount_paid` after it; either may be all a
  // notice carries.
  const paid = integer(raw["amount_paid"]) ?? (integer(raw["amount"]) ?? 0) + tax;
  return {
    amountPaidCents: paid,
    currency: (text(raw["currency"]) ?? "USD").toUpperCase(),
    id,
    occurredAt: date(raw["created_at"]),
    status: text(raw["status"]) ?? "paid",
    taxCents: tax,
  };
}

export function parseSubscription(value: unknown): CreemSubscription | null {
  const raw = asObject(value);
  const id = text(raw?.["id"]);
  if (!raw || !id) {
    return null;
  }
  return {
    canceledAt: date(raw["canceled_at"]),
    customerId: idOf(raw["customer"]),
    id,
    lastTransaction: parseTransaction(raw["last_transaction"]),
    metadata: metadataOf(raw["metadata"]),
    periodEnd: date(raw["current_period_end_date"]),
    periodStart: date(raw["current_period_start_date"]),
    productId: idOf(raw["product"]),
    status: text(raw["status"]) ?? "active",
  };
}

/** Whole cents to micros of the same currency. */
export function centsToMicros(cents: number): bigint {
  return BigInt(Math.round(cents)) * 10_000n;
}

// ---- The API ----

export interface CreemCheckoutInput {
  /** An existing Creem customer, or the email a new one starts with. */
  customer: { email: string } | { id: string };
  metadata: Record<string, string>;
  productId: string;
  requestId: string;
  successUrl: string;
}

export async function createCheckout(
  config: CreemConfig,
  input: CreemCheckoutInput,
  fetchImpl?: CreemFetch,
): Promise<{ id: string; url: string }> {
  const response = await creemRequest(config, "POST", "/v1/checkouts", {
    body: {
      customer: input.customer,
      metadata: input.metadata,
      product_id: input.productId,
      request_id: input.requestId,
      success_url: input.successUrl,
    },
    fetchImpl,
  });
  const id = text(response["id"]);
  const url = text(response["checkout_url"]);
  if (!id || !url) {
    throw new CreemError(502, "Creem returned a checkout without a URL");
  }
  return { id, url };
}

export async function getSubscription(
  config: CreemConfig,
  subscriptionId: string,
  fetchImpl?: CreemFetch,
): Promise<CreemSubscription> {
  const response = await creemRequest(config, "GET", "/v1/subscriptions", {
    fetchImpl,
    query: { subscription_id: subscriptionId },
  });
  const subscription = parseSubscription(response);
  if (!subscription) {
    throw new CreemError(502, "Creem returned a subscription without an id");
  }
  return subscription;
}

async function subscriptionAction(
  config: CreemConfig,
  subscriptionId: string,
  action: "cancel" | "resume" | "upgrade",
  body: Json | undefined,
  fetchImpl?: CreemFetch,
): Promise<CreemSubscription | null> {
  const response = await creemRequest(
    config,
    "POST",
    `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/${action}`,
    { body, fetchImpl },
  );
  return parseSubscription(response);
}

/** `scheduled` runs to the end of the period paid for; `immediate` ends now. */
export function cancelSubscription(
  config: CreemConfig,
  subscriptionId: string,
  mode: "immediate" | "scheduled",
  fetchImpl?: CreemFetch,
) {
  return subscriptionAction(
    config,
    subscriptionId,
    "cancel",
    mode === "scheduled" ? { mode, onExecute: "cancel" } : { mode },
    fetchImpl,
  );
}

/** Withdraws a scheduled cancellation. */
export function resumeSubscription(config: CreemConfig, subscriptionId: string, fetchImpl?: CreemFetch) {
  return subscriptionAction(config, subscriptionId, "resume", undefined, fetchImpl);
}

/**
 * Moves the subscription to another product at once. `charge` bills the
 * prorated difference now (an upgrade); `none` bills nothing until the next
 * renewal, which is then at the new price (a downgrade).
 */
export function changeSubscriptionProduct(
  config: CreemConfig,
  subscriptionId: string,
  productId: string,
  proration: "charge" | "none",
  fetchImpl?: CreemFetch,
) {
  return subscriptionAction(
    config,
    subscriptionId,
    "upgrade",
    {
      product_id: productId,
      update_behavior: proration === "charge" ? "proration-charge-immediately" : "proration-none",
    },
    fetchImpl,
  );
}

/** A link to Creem's customer portal: invoices, the card on file, cancel. */
export async function createPortalLink(
  config: CreemConfig,
  customerId: string,
  fetchImpl?: CreemFetch,
): Promise<string> {
  const response = await creemRequest(config, "POST", "/v1/customers/billing", {
    body: { customer_id: customerId },
    fetchImpl,
  });
  const link = text(response["customer_portal_link"]);
  if (!link) {
    throw new CreemError(502, "Creem returned no portal link");
  }
  return link;
}

export interface CreemProductInput {
  description: string;
  /** Makes a retry return the product the first call made. */
  idempotencyKey: string;
  name: string;
  priceCents: number;
}

/** A monthly subscription product in USD, tax added on top of the price. */
export async function createMonthlyProduct(
  config: CreemConfig,
  input: CreemProductInput,
  fetchImpl?: CreemFetch,
): Promise<string> {
  const response = await creemRequest(config, "POST", "/v1/products", {
    body: {
      billing_period: "every-month",
      billing_type: "recurring",
      currency: "USD",
      description: input.description,
      name: input.name,
      price: input.priceCents,
      tax_category: "saas",
      tax_mode: "exclusive",
    },
    fetchImpl,
    idempotencyKey: input.idempotencyKey,
  });
  const id = text(response["id"]);
  if (!id) {
    throw new CreemError(502, "Creem returned a product without an id");
  }
  return id;
}

export interface CreemProduct {
  billingPeriod: string | null;
  billingType: string | null;
  currency: string;
  id: string;
  name: string;
  priceCents: number;
  status: string;
}

/** Every product the store has in this mode, archived ones included. */
export async function listProducts(
  config: CreemConfig,
  fetchImpl?: CreemFetch,
): Promise<CreemProduct[]> {
  const products: CreemProduct[] = [];
  // A store holds a handful of products; the cap is against a loop, not a limit.
  for (let page = 1; page <= 20; page += 1) {
    const response = await creemRequest(config, "GET", "/v1/products/search", {
      fetchImpl,
      query: { page_number: String(page), page_size: "50" },
    });
    const items = Array.isArray(response["items"]) ? response["items"] : [];
    for (const item of items) {
      const raw = asObject(item);
      const id = text(raw?.["id"]);
      if (!raw || !id) {
        continue;
      }
      products.push({
        billingPeriod: text(raw["billing_period"]),
        billingType: text(raw["billing_type"]),
        currency: (text(raw["currency"]) ?? "USD").toUpperCase(),
        id,
        name: text(raw["name"]) ?? "",
        priceCents: integer(raw["price"]) ?? -1,
        status: text(raw["status"]) ?? "active",
      });
    }
    const totalPages = integer(asObject(response["pagination"])?.["total_pages"]) ?? 1;
    if (items.length === 0 || page >= totalPages) {
      break;
    }
  }
  return products;
}

// ---- Signatures ----

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A webhook is signed with HMAC-SHA256 of the raw body, hex, in `creem-signature`. */
export function webhookSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) {
    return false;
  }
  return safeEqualHex(signature.trim().toLowerCase(), webhookSignature(rawBody, secret));
}

/**
 * The return from checkout is signed with SHA-256 over its own query
 * parameters, in the order they appear, joined with "|", with the API key
 * as the last element. Empty and "null" values are left out by Creem and
 * so by us.
 */
export function redirectSignature(params: Iterable<[string, string]>, apiKey: string): string {
  const parts: string[] = [];
  for (const [key, value] of params) {
    if (key === "signature" || value === "" || value === "null") {
      continue;
    }
    parts.push(`${key}=${value}`);
  }
  parts.push(`salt=${apiKey}`);
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function verifyRedirectSignature(params: URLSearchParams, apiKey: string): boolean {
  const signature = params.get("signature");
  if (!signature) {
    return false;
  }
  return safeEqualHex(signature.trim().toLowerCase(), redirectSignature(params.entries(), apiKey));
}
