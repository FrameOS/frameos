import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signWebhookForTests } from "../lib/stripe";

// A stand-in for the part of Stripe's API the paid plans use
// (cloud/docs/billing.md), for the integration suite. It is a real HTTP
// server, so the routes reach it through the Stripe SDK exactly as they
// reach Stripe (form-encoded bodies, indexed arrays, expand), and it refuses
// a parameter Stripe does not know, which is how a typo in a call shows up
// here before it shows up against Stripe's test mode.
//
// It is our reading of Stripe's documented behaviour, not Stripe: prorations
// are worked out by the second like Stripe's, payments succeed at once, and
// the things Stripe does on its own (a renewal, a failed card, a refund made
// in the dashboard, a dispute) are methods a test calls. Each emits the
// events Stripe would send, signed with the webhook secret, for the test to
// deliver in whatever order it wants.

type Json = Record<string, unknown>;

export interface StripeFakeOptions {
  /** The settlement currency and the rate a USD charge converts at. */
  exchangeRate?: number;
  /** Stripe's card fee: a share of the amount plus a fixed part (minor units). */
  feeFixed?: number;
  feePercent?: number;
  now: () => Date;
  settlementCurrency?: string;
  /** The VAT Stripe Tax adds on top of an exclusive price, in percent. */
  taxPercent?: number;
  webhookSecret: string;
}

export interface FakeDelivery {
  body: string;
  eventId: string;
  eventType: string;
  signature: string;
}

class FakeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly code?: string,
    readonly param?: string,
  ) {
    super(message);
  }
}

// ---- Stripe's form encoding ----

/** `items[0][price]=x&expand[0]=y` back into objects and arrays. */
export function parseStripeForm(raw: string): Json {
  const root: Json = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    const path = key.replace(/\]/g, "").split("[");
    let node: Record<string, unknown> | unknown[] = root;
    for (let index = 0; index < path.length; index += 1) {
      const part = path[index]!;
      const last = index === path.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(path[index + 1]!);
      const container = node as Record<string, unknown>;
      if (last) {
        container[part] = value;
      } else {
        if (container[part] === undefined) {
          container[part] = nextIsIndex ? [] : {};
        }
        node = container[part] as Record<string, unknown> | unknown[];
      }
    }
  }
  return root;
}

function allow(params: Json, keys: string[]) {
  for (const key of Object.keys(params)) {
    if (!keys.includes(key)) {
      throw new FakeError(400, "invalid_request_error", `Received unknown parameter: ${key}`, "parameter_unknown", key);
    }
  }
}

function bool(value: unknown): boolean | undefined {
  return value === undefined ? undefined : value === "true" || value === true;
}

function int(value: unknown): number | undefined {
  return value === undefined || value === "" ? undefined : Number(value);
}

function stringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") {
        result[key] = entry;
      }
    }
  }
  return result;
}

function expands(params: Json): string[] {
  const value = params["expand"];
  return Array.isArray(value) ? value.map(String) : [];
}

const second = (date: Date) => Math.floor(date.getTime() / 1000);

function addMonth(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

// ---- The fake ----

interface FakePrice {
  active: boolean;
  currency: string;
  id: string;
  lookup_key: string | null;
  metadata: Record<string, string>;
  nickname: string | null;
  product: string;
  recurring: { interval: string; interval_count: number };
  tax_behavior: string;
  unit_amount: number;
}

interface FakeSubscription {
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  customer: string;
  ended_at: number | null;
  id: string;
  item: { id: string; price: string };
  latest_invoice: string | null;
  metadata: Record<string, string>;
  pending_update: { price: string } | null;
  periodEnd: Date;
  periodStart: Date;
  status: string;
}

interface FakeInvoice {
  amount_paid: number;
  billing_reason: string;
  created: number;
  currency: string;
  customer: string;
  id: string;
  lines: { amount: number; period: { end: number; start: number }; price: string }[];
  number: string;
  paid_at: number | null;
  payment_intent: string | null;
  status: string;
  subscription: string;
  tax: number;
  total: number;
}

interface FakeCharge {
  amount: number;
  balanceTransaction: { exchange_rate: number | null; fee: number; currency: string; id: string };
  id: string;
  invoice: string;
  payment_intent: string;
}

export class StripeFake {
  readonly calls: string[] = [];
  readonly charges = new Map<string, FakeCharge>();
  readonly checkouts = new Map<string, Json>();
  readonly customers = new Map<string, Json>();
  readonly disputes = new Map<string, Json>();
  readonly invoices = new Map<string, FakeInvoice>();
  readonly portalConfigurations = new Map<string, Json>();
  readonly prices = new Map<string, FakePrice>();
  readonly products = new Map<string, Json>();
  readonly refunds = new Map<string, Json>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly testClocks = new Map<string, Json>();
  /** What GET /v1/webhook_endpoints answers. */
  webhookEndpoints: Json[] = [];
  /** What GET /v1/tax/settings answers. */
  taxStatus = "active";
  /** Every request answers 503 (Stripe is down). */
  down = false;
  /** The next charge needs the customer (3-D Secure). */
  nextChargeNeedsAction = false;
  private deliveries: FakeDelivery[] = [];
  private counter = 0;

  constructor(readonly options: StripeFakeOptions) {}

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${randomBytes(6).toString("hex")}${this.counter}`;
  }

  // Stripe's clock has whole seconds.
  private now(): Date {
    return new Date(Math.floor(this.options.now().getTime() / 1000) * 1000);
  }

  // ---- Events ----

  private emit(type: string, object: Json) {
    const event = {
      api_version: "2026-09-30.endive",
      created: second(this.now()),
      data: { object },
      id: this.id("evt"),
      livemode: false,
      object: "event",
      type,
    };
    const body = JSON.stringify(event);
    this.deliveries.push({
      body,
      eventId: event.id,
      eventType: type,
      signature: signWebhookForTests(body, this.options.webhookSecret, second(new Date())),
    });
  }

  /** The events sent since the last call, oldest first. */
  takeDeliveries(): FakeDelivery[] {
    const taken = this.deliveries;
    this.deliveries = [];
    return taken;
  }

  // ---- Objects as Stripe shows them ----

  private priceObject(price: FakePrice): Json {
    return { object: "price", type: "recurring", ...price };
  }

  subscriptionObject(subscription: FakeSubscription, expand: string[] = []): Json {
    const latest =
      subscription.latest_invoice && expand.includes("latest_invoice")
        ? this.invoiceObject(this.invoices.get(subscription.latest_invoice)!)
        : subscription.latest_invoice;
    const price = this.prices.get(subscription.item.price)!;
    return {
      cancel_at: subscription.cancel_at_period_end ? second(subscription.periodEnd) : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
      canceled_at: subscription.canceled_at,
      currency: "usd",
      customer: subscription.customer,
      ended_at: subscription.ended_at,
      id: subscription.id,
      items: {
        data: [
          {
            current_period_end: second(subscription.periodEnd),
            current_period_start: second(subscription.periodStart),
            id: subscription.item.id,
            object: "subscription_item",
            price: this.priceObject(price),
            quantity: 1,
            subscription: subscription.id,
          },
        ],
        has_more: false,
        object: "list",
      },
      latest_invoice: latest,
      livemode: false,
      metadata: subscription.metadata,
      object: "subscription",
      pending_update: subscription.pending_update
        ? { subscription_items: [{ price: subscription.pending_update.price }] }
        : null,
      status: subscription.status,
    };
  }

  invoiceObject(invoice: FakeInvoice): Json {
    return {
      amount_due: invoice.total,
      amount_paid: invoice.amount_paid,
      amount_remaining: invoice.status === "paid" ? 0 : invoice.total - invoice.amount_paid,
      billing_reason: invoice.billing_reason,
      created: invoice.created,
      currency: invoice.currency,
      customer: invoice.customer,
      customer_email: "buyer@example.com",
      customer_name: "A Buyer",
      hosted_invoice_url: `https://invoice.stripe.fake/${invoice.id}`,
      id: invoice.id,
      invoice_pdf: `https://pay.stripe.fake/invoice/${invoice.id}/pdf`,
      lines: {
        data: invoice.lines.map((line, index) => ({
          amount: line.amount,
          id: `il_${invoice.id}_${index}`,
          object: "line_item",
          period: line.period,
          pricing: { price_details: { price: line.price, product: this.prices.get(line.price)?.product }, type: "price_details" },
        })),
        has_more: false,
        object: "list",
      },
      livemode: false,
      number: invoice.number,
      object: "invoice",
      parent: {
        subscription_details: { metadata: {}, subscription: invoice.subscription },
        type: "subscription_details",
      },
      status: invoice.status,
      status_transitions: { paid_at: invoice.paid_at },
      subtotal: invoice.total - invoice.tax,
      total: invoice.total,
      total_taxes:
        invoice.tax > 0
          ? [{ amount: invoice.tax, tax_behavior: "exclusive", taxable_amount: invoice.total - invoice.tax, taxability_reason: "standard_rated", type: "tax_rate_details" }]
          : [],
    };
  }

  // ---- Money ----

  private taxOn(amount: number): number {
    return amount > 0 ? Math.round((amount * (this.options.taxPercent ?? 0)) / 100) : 0;
  }

  /** Make an invoice and, unless the card wants the customer, pay it. */
  private invoice(
    subscription: FakeSubscription,
    reason: string,
    lines: FakeInvoice["lines"],
    options: { fail?: boolean } = {},
  ): FakeInvoice {
    const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
    const net = Math.max(0, subtotal);
    const tax = this.taxOn(net);
    const invoice: FakeInvoice = {
      amount_paid: 0,
      billing_reason: reason,
      created: second(this.now()),
      currency: "usd",
      customer: subscription.customer,
      id: this.id("in"),
      lines,
      number: `FAKE-${String(this.invoices.size + 1).padStart(4, "0")}`,
      paid_at: null,
      payment_intent: null,
      status: "open",
      subscription: subscription.id,
      tax,
      total: net + tax,
    };
    this.invoices.set(invoice.id, invoice);
    subscription.latest_invoice = invoice.id;
    const needsAction = this.nextChargeNeedsAction;
    this.nextChargeNeedsAction = false;
    if (invoice.total === 0) {
      invoice.status = "paid";
      invoice.paid_at = second(this.now());
    } else if (!options.fail && !needsAction) {
      this.pay(invoice);
    }
    return invoice;
  }

  private pay(invoice: FakeInvoice) {
    invoice.status = "paid";
    invoice.amount_paid = invoice.total;
    invoice.paid_at = second(this.now());
    const rate = this.options.exchangeRate ?? null;
    const settled = rate ? Math.round(invoice.total * rate) : invoice.total;
    const fee =
      Math.round((settled * (this.options.feePercent ?? 2.9)) / 100) + (this.options.feeFixed ?? 30);
    const charge: FakeCharge = {
      amount: invoice.total,
      balanceTransaction: {
        currency: this.options.settlementCurrency ?? "usd",
        exchange_rate: rate,
        fee,
        id: this.id("txn"),
      },
      id: this.id("ch"),
      invoice: invoice.id,
      payment_intent: this.id("pi"),
    };
    invoice.payment_intent = charge.payment_intent;
    this.charges.set(charge.id, charge);
  }

  private chargeForInvoice(invoiceId: string): FakeCharge | undefined {
    return [...this.charges.values()].find((charge) => charge.invoice === invoiceId);
  }

  // ---- What Stripe does on its own (test helpers) ----

  /** The buyer paid at checkout: the subscription exists and is paid. */
  completeCheckout(sessionId: string): string {
    const session = this.checkouts.get(sessionId);
    if (!session) {
      throw new Error(`No checkout ${sessionId}`);
    }
    const now = this.now();
    let customer = session["customer"] as string | null;
    if (!customer) {
      customer = this.id("cus");
      this.customers.set(customer, { email: session["customer_email"], id: customer, object: "customer" });
    }
    const price = this.prices.get(session["price"] as string)!;
    const subscription: FakeSubscription = {
      cancel_at_period_end: false,
      canceled_at: null,
      customer,
      ended_at: null,
      id: this.id("sub"),
      item: { id: this.id("si"), price: price.id },
      latest_invoice: null,
      metadata: session["subscription_metadata"] as Record<string, string>,
      pending_update: null,
      periodEnd: addMonth(now),
      periodStart: now,
      status: "active",
    };
    this.subscriptions.set(subscription.id, subscription);
    const invoice = this.invoice(subscription, "subscription_create", [
      {
        amount: price.unit_amount,
        period: { end: second(subscription.periodEnd), start: second(now) },
        price: price.id,
      },
    ]);
    session["status"] = "complete";
    session["payment_status"] = "paid";
    session["subscription"] = subscription.id;
    session["customer"] = customer;
    this.emit("checkout.session.completed", this.sessionObject(session));
    this.emit("customer.subscription.created", this.subscriptionObject(subscription));
    this.emit("invoice.paid", this.invoiceObject(invoice));
    return String(session["success_url"]).replace("{CHECKOUT_SESSION_ID}", sessionId);
  }

  /** The period ran out: renew it (paid, or the card fails), or end it. */
  renew(subscriptionId: string, options: { fail?: boolean } = {}) {
    const subscription = this.subscriptions.get(subscriptionId)!;
    const start = subscription.periodEnd;
    if (subscription.cancel_at_period_end) {
      subscription.status = "canceled";
      subscription.ended_at = second(start);
      subscription.canceled_at = subscription.canceled_at ?? second(start);
      this.emit("customer.subscription.deleted", this.subscriptionObject(subscription));
      return;
    }
    subscription.periodStart = start;
    subscription.periodEnd = addMonth(start);
    const price = this.prices.get(subscription.item.price)!;
    const invoice = this.invoice(
      subscription,
      "subscription_cycle",
      [
        {
          amount: price.unit_amount,
          period: { end: second(subscription.periodEnd), start: second(start) },
          price: price.id,
        },
      ],
      options,
    );
    if (invoice.status === "paid") {
      this.emit("invoice.paid", this.invoiceObject(invoice));
    } else {
      subscription.status = "past_due";
      this.emit("invoice.payment_failed", this.invoiceObject(invoice));
    }
    this.emit("customer.subscription.updated", this.subscriptionObject(subscription));
  }

  /** The customer paid an open invoice (after 3-D Secure, or a new card). */
  payInvoice(invoiceId: string) {
    const invoice = this.invoices.get(invoiceId)!;
    this.pay(invoice);
    const subscription = this.subscriptions.get(invoice.subscription)!;
    if (subscription.pending_update) {
      subscription.item.price = subscription.pending_update.price;
      subscription.pending_update = null;
    }
    if (subscription.status === "past_due") {
      subscription.status = "active";
    }
    this.emit("invoice.paid", this.invoiceObject(invoice));
    this.emit("customer.subscription.updated", this.subscriptionObject(subscription));
  }

  /** An operator changed the price in Stripe's dashboard, with no invoice now. */
  changePriceInDashboard(subscriptionId: string, priceId: string) {
    const subscription = this.subscriptions.get(subscriptionId)!;
    subscription.item.price = priceId;
    this.emit("customer.subscription.updated", this.subscriptionObject(subscription));
  }

  /** Stripe gave up on the card, or an operator ended it in the dashboard. */
  cancelNow(subscriptionId: string) {
    const subscription = this.subscriptions.get(subscriptionId)!;
    subscription.status = "canceled";
    subscription.canceled_at = second(this.now());
    subscription.ended_at = second(this.now());
    this.emit("customer.subscription.deleted", this.subscriptionObject(subscription));
  }

  /** A refund made in Stripe's dashboard. */
  refund(invoiceId: string, options: { amount?: number; pending?: boolean } = {}): string {
    const charge = this.chargeForInvoice(invoiceId)!;
    const refund: Json = {
      amount: options.amount ?? charge.amount,
      charge: charge.id,
      currency: "usd",
      id: this.id("re"),
      object: "refund",
      payment_intent: charge.payment_intent,
      status: options.pending ? "pending" : "succeeded",
    };
    this.refunds.set(refund["id"] as string, refund);
    this.emit("refund.created", refund);
    return refund["id"] as string;
  }

  settleRefund(refundId: string) {
    const refund = this.refunds.get(refundId)!;
    refund["status"] = "succeeded";
    this.emit("refund.updated", refund);
  }

  /** The cardholder's bank opened a chargeback. */
  dispute(invoiceId: string): string {
    const charge = this.chargeForInvoice(invoiceId)!;
    const dispute: Json = {
      amount: charge.amount,
      balance_transactions: [
        {
          // Stripe charges the dispute fee in the balance's own currency,
          // and its balance transaction names no rate (seen in test mode).
          amount: -charge.amount,
          currency: this.options.settlementCurrency ?? "usd",
          exchange_rate: null,
          fee: this.options.settlementCurrency ? 2000 : 1500,
          id: this.id("txn"),
          object: "balance_transaction",
        },
      ],
      charge: charge.id,
      currency: "usd",
      id: this.id("du"),
      object: "dispute",
      payment_intent: charge.payment_intent,
      reason: "fraudulent",
      status: "needs_response",
    };
    this.disputes.set(dispute["id"] as string, dispute);
    this.emit("charge.dispute.created", dispute);
    return dispute["id"] as string;
  }

  closeDispute(disputeId: string, outcome: "lost" | "won") {
    const dispute = this.disputes.get(disputeId)!;
    dispute["status"] = outcome;
    if (outcome === "won") {
      // The money comes back; the fee is Stripe's either way.
      (dispute["balance_transactions"] as Json[]).push({
        amount: dispute["amount"],
        currency: this.options.settlementCurrency ?? "usd",
        exchange_rate: null,
        fee: 0,
        id: this.id("txn"),
        object: "balance_transaction",
      });
    }
    this.emit("charge.dispute.closed", dispute);
  }

  // ---- The HTTP API ----

  private sessionObject(session: Json): Json {
    const { price: _price, subscription_metadata: _metadata, ...rest } = session;
    void _price;
    void _metadata;
    return { ...rest, object: "checkout.session" };
  }

  private list(data: Json[], url: string): Json {
    return { data, has_more: false, object: "list", url };
  }

  handle(method: string, path: string, params: Json): Json {
    this.calls.push(`${method} ${path}`);
    if (this.down) {
      throw new FakeError(503, "api_error", "Stripe is down (fake)");
    }
    const segments = path.replace(/^\/v1\//, "").split("/");
    const [resource, id, action] = segments;

    if (resource === "products" && method === "GET" && !id) {
      allow(params, ["active", "limit", "starting_after"]);
      return this.list(
        [...this.products.values()].filter((product) => bool(params["active"]) === undefined || product["active"] === bool(params["active"])),
        "/v1/products",
      );
    }
    if (resource === "products" && method === "POST") {
      allow(params, ["description", "metadata", "name", "tax_code"]);
      if (id) {
        const product = this.products.get(id);
        if (!product) {
          throw new FakeError(404, "invalid_request_error", `No such product: '${id}'`, "resource_missing");
        }
        Object.assign(product, { description: params["description"], name: params["name"], tax_code: params["tax_code"] });
        return product;
      }
      const product: Json = {
        active: true,
        description: params["description"] ?? null,
        id: this.id("prod"),
        metadata: stringMap(params["metadata"]),
        name: params["name"],
        object: "product",
        tax_code: params["tax_code"] ?? null,
      };
      this.products.set(product["id"] as string, product);
      return product;
    }
    if (resource === "prices" && method === "GET" && !id) {
      allow(params, ["active", "limit", "lookup_keys"]);
      const keys = Array.isArray(params["lookup_keys"]) ? params["lookup_keys"].map(String) : null;
      if (keys && keys.length > 10) {
        throw new FakeError(400, "invalid_request_error", "lookup_keys: at most 10", "parameter_invalid_integer", "lookup_keys");
      }
      return this.list(
        [...this.prices.values()]
          .filter((price) => bool(params["active"]) === undefined || price.active === bool(params["active"]))
          .filter((price) => !keys || (price.lookup_key !== null && keys.includes(price.lookup_key)))
          .map((price) => this.priceObject(price)),
        "/v1/prices",
      );
    }
    if (resource === "prices" && method === "POST" && !id) {
      allow(params, [
        "currency",
        "lookup_key",
        "metadata",
        "nickname",
        "product",
        "recurring",
        "tax_behavior",
        "transfer_lookup_key",
        "unit_amount",
      ]);
      const lookup = typeof params["lookup_key"] === "string" ? params["lookup_key"] : null;
      if (lookup) {
        const holder = [...this.prices.values()].find((price) => price.lookup_key === lookup);
        if (holder) {
          if (!bool(params["transfer_lookup_key"])) {
            throw new FakeError(400, "invalid_request_error", `A price (${holder.id}) already uses that lookup key.`);
          }
          holder.lookup_key = null;
        }
      }
      if (!this.products.has(String(params["product"]))) {
        throw new FakeError(400, "invalid_request_error", `No such product: '${String(params["product"])}'`, "resource_missing", "product");
      }
      const recurring = (params["recurring"] ?? {}) as Json;
      const price: FakePrice = {
        active: true,
        currency: String(params["currency"]),
        id: this.id("price"),
        lookup_key: lookup,
        metadata: stringMap(params["metadata"]),
        nickname: typeof params["nickname"] === "string" ? params["nickname"] : null,
        product: String(params["product"]),
        recurring: { interval: String(recurring["interval"]), interval_count: int(recurring["interval_count"]) ?? 1 },
        tax_behavior: String(params["tax_behavior"] ?? "unspecified"),
        unit_amount: int(params["unit_amount"]) ?? 0,
      };
      this.prices.set(price.id, price);
      return this.priceObject(price);
    }
    if (resource === "billing_portal" && id === "configurations" && method === "GET") {
      allow(params, ["active", "limit"]);
      return this.list([...this.portalConfigurations.values()], "/v1/billing_portal/configurations");
    }
    if (resource === "billing_portal" && id === "configurations" && method === "POST") {
      allow(params, ["business_profile", "default_return_url", "features", "metadata"]);
      const features = params["features"] as Json | undefined;
      const update = (features?.["subscription_update"] ?? {}) as Json;
      if (bool(update["enabled"]) !== false) {
        throw new FakeError(400, "invalid_request_error", "The fake expects plan changes left out of the portal");
      }
      if (action) {
        const existing = this.portalConfigurations.get(action);
        if (!existing) {
          throw new FakeError(404, "invalid_request_error", `No such configuration: '${action}'`, "resource_missing");
        }
        Object.assign(existing, { business_profile: params["business_profile"], features });
        return existing;
      }
      const configuration: Json = {
        active: true,
        business_profile: params["business_profile"],
        features,
        id: this.id("bpc"),
        metadata: stringMap(params["metadata"]),
        object: "billing_portal.configuration",
      };
      this.portalConfigurations.set(configuration["id"] as string, configuration);
      return configuration;
    }
    if (resource === "billing_portal" && id === "sessions" && method === "POST") {
      allow(params, ["configuration", "customer", "return_url"]);
      const customer = String(params["customer"]);
      if (!this.customers.has(customer)) {
        throw new FakeError(400, "invalid_request_error", `No such customer: '${customer}'`, "resource_missing");
      }
      return { id: this.id("bps"), object: "billing_portal.session", url: `https://billing.stripe.fake/p/session/${customer}` };
    }
    if (resource === "tax" && id === "settings" && method === "GET") {
      allow(params, []);
      return { object: "tax.settings", status: this.taxStatus };
    }
    if (resource === "webhook_endpoints" && method === "GET") {
      allow(params, ["limit"]);
      return this.list(this.webhookEndpoints, "/v1/webhook_endpoints");
    }
    if (resource === "test_helpers" && id === "test_clocks" && method === "POST") {
      allow(params, ["frozen_time", "name"]);
      const clock: Json = { frozen_time: int(params["frozen_time"]), id: this.id("clock"), name: params["name"], object: "test_helpers.test_clock" };
      this.testClocks.set(clock["id"] as string, clock);
      return clock;
    }
    if (resource === "customers" && method === "POST" && !id) {
      allow(params, ["email", "metadata", "test_clock"]);
      const customer: Json = {
        email: params["email"],
        id: this.id("cus"),
        metadata: stringMap(params["metadata"]),
        object: "customer",
        test_clock: params["test_clock"] ?? null,
      };
      this.customers.set(customer["id"] as string, customer);
      return customer;
    }
    if (resource === "checkout" && id === "sessions" && method === "POST" && !action) {
      allow(params, [
        "adaptive_pricing",
        "allow_promotion_codes",
        "automatic_tax",
        "billing_address_collection",
        "cancel_url",
        "client_reference_id",
        "customer",
        "customer_email",
        "customer_update",
        "line_items",
        "locale",
        "metadata",
        "mode",
        "subscription_data",
        "success_url",
        "tax_id_collection",
      ]);
      if (params["customer"] && params["customer_email"]) {
        throw new FakeError(400, "invalid_request_error", "You may only specify one of these parameters: customer, customer_email.");
      }
      if (params["customer_update"] && !params["customer"]) {
        throw new FakeError(400, "invalid_request_error", "customer_update can only be used with customer.");
      }
      if (params["customer"] && !this.customers.has(String(params["customer"]))) {
        throw new FakeError(400, "invalid_request_error", `No such customer: '${String(params["customer"])}'`, "resource_missing");
      }
      const items = params["line_items"] as Json[];
      const price = String(items?.[0]?.["price"] ?? "");
      if (!this.prices.get(price)?.active) {
        throw new FakeError(400, "invalid_request_error", `No such price: '${price}'`, "resource_missing");
      }
      const id = `cs_test_${randomBytes(12).toString("hex")}`;
      const session: Json = {
        adaptive_pricing: { enabled: bool((params["adaptive_pricing"] as Json | undefined)?.["enabled"]) ?? true },
        automatic_tax: { enabled: bool((params["automatic_tax"] as Json | undefined)?.["enabled"]) ?? false },
        cancel_url: params["cancel_url"],
        client_reference_id: params["client_reference_id"] ?? null,
        customer: params["customer"] ?? null,
        customer_email: params["customer_email"] ?? null,
        id,
        metadata: stringMap(params["metadata"]),
        mode: params["mode"],
        payment_status: "unpaid",
        price,
        status: "open",
        subscription: null,
        subscription_metadata: stringMap((params["subscription_data"] as Json | undefined)?.["metadata"]),
        success_url: params["success_url"],
        tax_id_collection: params["tax_id_collection"],
        url: `https://checkout.stripe.fake/c/pay/${id}`,
      };
      this.checkouts.set(id, session);
      return this.sessionObject(session);
    }
    if (resource === "checkout" && id === "sessions" && method === "GET" && action) {
      allow(params, ["expand"]);
      const session = this.checkouts.get(action);
      if (!session) {
        throw new FakeError(404, "invalid_request_error", `No such checkout.session: '${action}'`, "resource_missing");
      }
      return this.sessionObject(session);
    }
    if (resource === "subscriptions" && id) {
      const subscription = this.subscriptions.get(id);
      if (!subscription) {
        throw new FakeError(404, "invalid_request_error", `No such subscription: '${id}'`, "resource_missing");
      }
      if (method === "GET") {
        allow(params, ["expand"]);
        return this.subscriptionObject(subscription, expands(params));
      }
      if (method === "DELETE") {
        allow(params, ["invoice_now", "prorate"]);
        if (subscription.status === "canceled") {
          throw new FakeError(400, "invalid_request_error", "This subscription is already canceled", "resource_missing");
        }
        subscription.status = "canceled";
        subscription.canceled_at = second(this.now());
        subscription.ended_at = second(this.now());
        this.emit("customer.subscription.deleted", this.subscriptionObject(subscription));
        return this.subscriptionObject(subscription);
      }
      if (method === "POST") {
        allow(params, ["cancel_at_period_end", "expand", "items", "payment_behavior", "proration_behavior"]);
        if (subscription.status === "canceled") {
          throw new FakeError(400, "invalid_request_error", "A canceled subscription can only update its cancellation_details and metadata.");
        }
        const cancel = bool(params["cancel_at_period_end"]);
        if (cancel !== undefined) {
          subscription.cancel_at_period_end = cancel;
          subscription.canceled_at = cancel ? second(this.now()) : null;
        }
        const items = params["items"] as Json[] | undefined;
        if (items) {
          const item = items[0]!;
          if (item["id"] !== subscription.item.id) {
            throw new FakeError(400, "invalid_request_error", `No such subscription item: '${String(item["id"])}'`, "resource_missing");
          }
          const next = this.prices.get(String(item["price"]));
          if (!next) {
            throw new FakeError(400, "invalid_request_error", `No such price: '${String(item["price"])}'`, "resource_missing");
          }
          const proration = String(params["proration_behavior"] ?? "create_prorations");
          if (proration === "always_invoice") {
            if (params["payment_behavior"] !== "pending_if_incomplete") {
              throw new FakeError(400, "invalid_request_error", "The fake expects pending_if_incomplete with always_invoice");
            }
            // Prorated by the second, like Stripe: the unused rest of the old
            // price back as a credit, the rest of the period at the new one.
            const now = this.now();
            const total = subscription.periodEnd.getTime() - subscription.periodStart.getTime();
            const left = Math.max(0, subscription.periodEnd.getTime() - now.getTime());
            const share = total > 0 ? left / total : 0;
            const old = this.prices.get(subscription.item.price)!;
            const period = { end: second(subscription.periodEnd), start: second(now) };
            const invoice = this.invoice(subscription, "subscription_update", [
              { amount: -Math.round(old.unit_amount * share), period, price: old.id },
              { amount: Math.round(next.unit_amount * share), period, price: next.id },
            ]);
            if (invoice.status === "paid") {
              subscription.item.price = next.id;
              this.emit("invoice.paid", this.invoiceObject(invoice));
            } else {
              subscription.pending_update = { price: next.id };
              this.emit("invoice.payment_action_required", this.invoiceObject(invoice));
            }
          } else if (proration === "none") {
            subscription.item.price = next.id;
          } else {
            throw new FakeError(400, "invalid_request_error", `The fake does not do proration_behavior=${proration}`);
          }
        }
        this.emit("customer.subscription.updated", this.subscriptionObject(subscription));
        return this.subscriptionObject(subscription, expands(params));
      }
    }
    if (resource === "invoices" && method === "GET" && !id) {
      allow(params, ["customer", "limit"]);
      const limit = Number(params["limit"] ?? 10);
      // Newest first, as Stripe lists them.
      const invoices = [...this.invoices.values()]
        .filter((invoice) => !params["customer"] || invoice.customer === params["customer"])
        .reverse()
        .slice(0, limit);
      return this.list(
        invoices.map((invoice) => this.invoiceObject(invoice)),
        "/v1/invoices",
      );
    }
    if (resource === "invoices" && method === "GET" && id) {
      allow(params, ["expand"]);
      const invoice = this.invoices.get(id);
      if (!invoice) {
        throw new FakeError(404, "invalid_request_error", `No such invoice: '${id}'`, "resource_missing");
      }
      return this.invoiceObject(invoice);
    }
    if (resource === "invoice_payments" && method === "GET" && !id) {
      allow(params, ["invoice", "limit", "payment"]);
      const payment = params["payment"] as Json | undefined;
      const charges = [...this.charges.values()].filter((charge) =>
        params["invoice"] ? charge.invoice === params["invoice"] : charge.payment_intent === payment?.["payment_intent"],
      );
      return this.list(
        charges.map((charge) => ({
          amount_paid: charge.amount,
          id: this.id("inpay"),
          invoice: charge.invoice,
          object: "invoice_payment",
          payment: { payment_intent: charge.payment_intent, type: "payment_intent" },
          status: "paid",
        })),
        "/v1/invoice_payments",
      );
    }
    if (resource === "payment_intents" && method === "GET" && id) {
      allow(params, ["expand"]);
      const charge = [...this.charges.values()].find((entry) => entry.payment_intent === id);
      if (!charge) {
        throw new FakeError(404, "invalid_request_error", `No such payment_intent: '${id}'`, "resource_missing");
      }
      const expanded = expands(params).includes("latest_charge.balance_transaction");
      return {
        id,
        latest_charge: expanded
          ? { balance_transaction: { ...charge.balanceTransaction, object: "balance_transaction" }, id: charge.id, object: "charge" }
          : charge.id,
        object: "payment_intent",
        status: "succeeded",
      };
    }
    if (resource === "refunds" && method === "GET" && id) {
      allow(params, []);
      const refund = this.refunds.get(id);
      if (!refund) {
        throw new FakeError(404, "invalid_request_error", `No such refund: '${id}'`, "resource_missing");
      }
      return refund;
    }
    if (resource === "disputes" && method === "GET" && id) {
      allow(params, []);
      const dispute = this.disputes.get(id);
      if (!dispute) {
        throw new FakeError(404, "invalid_request_error", `No such dispute: '${id}'`, "resource_missing");
      }
      return dispute;
    }
    throw new FakeError(404, "invalid_request_error", `Unrecognized request URL (${method}: ${path}) (fake)`);
  }

  /** Archive a price, as an operator would in Stripe's dashboard. */
  archivePrice(priceId: string) {
    const price = this.prices.get(priceId)!;
    price.active = false;
  }
}

export interface RunningStripeFake {
  close: () => Promise<void>;
  url: string;
}

/** Serve a fake over HTTP on a free local port. `current` picks the fake per request. */
export async function serveStripeFake(current: () => StripeFake): Promise<RunningStripeFake> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://stripe.fake");
      const body = Buffer.concat(chunks).toString("utf8");
      const params = parseStripeForm(request.method === "GET" || request.method === "DELETE" ? url.search.slice(1) : body);
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json", "request-id": "req_fake" });
        response.end(JSON.stringify(payload));
      };
      if (!String(request.headers["authorization"] ?? "").startsWith("Bearer sk_test_")) {
        send(401, { error: { message: "Invalid API Key provided (fake)", type: "invalid_request_error" } });
        return;
      }
      try {
        send(200, current().handle(request.method ?? "GET", url.pathname, params));
      } catch (error) {
        if (error instanceof FakeError) {
          send(error.status, {
            error: {
              ...(error.code ? { code: error.code } : {}),
              message: error.message,
              ...(error.param ? { param: error.param } : {}),
              type: error.type,
            },
          });
        } else {
          send(500, { error: { message: String(error), type: "api_error" } });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${port}`,
  };
}
