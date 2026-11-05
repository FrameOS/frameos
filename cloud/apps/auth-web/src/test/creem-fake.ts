import { randomBytes } from "node:crypto";
import { redirectSignature, webhookSignature, type CreemFetch } from "../lib/creem";

// A stand-in for Creem's test API, small enough to read: the endpoints
// src/lib/creem.ts calls, the objects they answer with, and the webhooks a
// real purchase would cause. The integration tests drive it in process;
// scripts/creem-fake.ts puts an HTTP server and a checkout page around it
// so the whole flow can be clicked through without a Creem account.
//
// It is our reading of Creem, not Creem. The reading was checked against
// the real test API on 2026-11-06 (cloud/docs/billing.md has the table):
// the event names and order, the signed return, proration on a plan change
// (charged from the provider's current product, reported a moment after
// the change), refunds and cancellation behave as they do here. Renewals
// and failed renewals have only ever run here.

type Json = Record<string, unknown>;

export interface FakeProduct {
  currency: string;
  description: string;
  id: string;
  name: string;
  priceCents: number;
}

export interface FakeTransaction {
  amountCents: number;
  createdAt: Date;
  currency: string;
  id: string;
  refundedCents: number;
  status: string;
  subscriptionId: string;
  taxCents: number;
}

export interface FakeSubscription {
  canceledAt: Date | null;
  createdAt: Date;
  customerId: string;
  id: string;
  lastTransactionId: string | null;
  metadata: Record<string, string>;
  periodEnd: Date;
  periodStart: Date;
  productId: string;
  status: string;
  updatedAt: Date;
}

export interface FakeCheckout {
  customer: { email?: string; id?: string };
  id: string;
  metadata: Record<string, string>;
  productId: string;
  requestId: string | null;
  status: "completed" | "pending";
  successUrl: string;
}

export interface FakeCustomer {
  country: string;
  email: string;
  id: string;
  name: string;
}

export interface SignedDelivery {
  body: string;
  eventType: string;
  signature: string;
}

export interface CreemFakeOptions {
  apiKey: string;
  /** Where its own checkout and portal pages live (the HTTP wrapper's origin). */
  baseUrl?: string;
  now?: () => Date;
  /**
   * Whether a plan change that charges the card reports that charge on the
   * subscription at once. Real Creem does not (false): the charge arrives
   * with a `subscription.paid` a moment later. Both orders are run.
   */
  prorationReported?: boolean;
  /** Added on top of every price, as a tax-exclusive product is charged. */
  taxPercent?: number;
  webhookSecret: string;
}

function addMonth(at: Date): Date {
  const next = new Date(at.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export class CreemFake {
  readonly checkouts = new Map<string, FakeCheckout>();
  readonly customers = new Map<string, FakeCustomer>();
  readonly products = new Map<string, FakeProduct>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly transactions = new Map<string, FakeTransaction>();
  /** Products archived in the dashboard. */
  readonly archived = new Set<string>();
  /** Every API call it answered, for assertions: "POST /v1/checkouts". */
  readonly calls: string[] = [];
  private readonly idempotent = new Map<string, string>();
  private readonly outbox: SignedDelivery[] = [];
  private counter = 0;

  constructor(private readonly options: CreemFakeOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${randomBytes(6).toString("hex")}${this.counter}`;
  }

  /** Everything it holds, as JSON, so the HTTP wrapper can survive a restart. */
  snapshot(): string {
    return JSON.stringify({
      checkouts: [...this.checkouts.values()],
      counter: this.counter,
      customers: [...this.customers.values()],
      idempotent: [...this.idempotent.entries()],
      products: [...this.products.values()],
      subscriptions: [...this.subscriptions.values()],
      transactions: [...this.transactions.values()],
    });
  }

  restore(snapshot: string): void {
    const state = JSON.parse(snapshot) as {
      checkouts: FakeCheckout[];
      counter: number;
      customers: FakeCustomer[];
      idempotent: [string, string][];
      products: FakeProduct[];
      subscriptions: (Omit<FakeSubscription, "canceledAt" | "createdAt" | "periodEnd" | "periodStart" | "updatedAt"> &
        Record<"canceledAt" | "createdAt" | "periodEnd" | "periodStart" | "updatedAt", string | null>)[];
      transactions: (Omit<FakeTransaction, "createdAt"> & { createdAt: string })[];
    };
    const date = (value: string | null) => new Date(value ?? 0);
    this.counter = state.counter;
    for (const checkout of state.checkouts) {
      this.checkouts.set(checkout.id, checkout);
    }
    for (const customer of state.customers) {
      this.customers.set(customer.id, customer);
    }
    for (const [key, value] of state.idempotent) {
      this.idempotent.set(key, value);
    }
    for (const product of state.products) {
      this.products.set(product.id, product);
    }
    for (const subscription of state.subscriptions) {
      this.subscriptions.set(subscription.id, {
        ...subscription,
        canceledAt: subscription.canceledAt ? date(subscription.canceledAt) : null,
        createdAt: date(subscription.createdAt),
        periodEnd: date(subscription.periodEnd),
        periodStart: date(subscription.periodStart),
        updatedAt: date(subscription.updatedAt),
      });
    }
    for (const transaction of state.transactions) {
      this.transactions.set(transaction.id, { ...transaction, createdAt: date(transaction.createdAt) });
    }
  }

  // ---- Objects as the API and the webhooks spell them ----

  private productJson(product: FakeProduct): Json {
    return {
      billing_period: "every-month",
      billing_type: "recurring",
      currency: product.currency,
      description: product.description,
      id: product.id,
      mode: "test",
      name: product.name,
      object: "product",
      price: product.priceCents,
      status: "active",
      tax_category: "saas",
      tax_mode: "exclusive",
    };
  }

  private customerJson(customer: FakeCustomer): Json {
    return {
      country: customer.country,
      email: customer.email,
      id: customer.id,
      mode: "test",
      name: customer.name,
      object: "customer",
    };
  }

  private transactionJson(transaction: FakeTransaction): Json {
    return {
      amount: transaction.amountCents,
      amount_paid: transaction.amountCents + transaction.taxCents,
      created_at: transaction.createdAt.getTime(),
      currency: transaction.currency,
      id: transaction.id,
      mode: "test",
      object: "transaction",
      refunded_amount: transaction.refundedCents || null,
      status: transaction.status,
      subscription: transaction.subscriptionId,
      tax_amount: transaction.taxCents,
      type: "invoice",
    };
  }

  subscriptionJson(subscription: FakeSubscription): Json {
    const product = this.products.get(subscription.productId);
    const customer = this.customers.get(subscription.customerId);
    const transaction = subscription.lastTransactionId
      ? this.transactions.get(subscription.lastTransactionId)
      : undefined;
    return {
      canceled_at: subscription.canceledAt?.toISOString() ?? null,
      collection_method: "charge_automatically",
      created_at: subscription.createdAt.toISOString(),
      current_period_end_date: subscription.periodEnd.toISOString(),
      current_period_start_date: subscription.periodStart.toISOString(),
      customer: customer ? this.customerJson(customer) : subscription.customerId,
      id: subscription.id,
      metadata: subscription.metadata,
      mode: "test",
      object: "subscription",
      product: product ? this.productJson(product) : subscription.productId,
      status: subscription.status,
      updated_at: subscription.updatedAt.toISOString(),
      ...(transaction
        ? {
            last_transaction: this.transactionJson(transaction),
            last_transaction_id: transaction.id,
          }
        : {}),
    };
  }

  private queue(eventType: string, object: Json) {
    const body = JSON.stringify({
      created_at: this.now().getTime(),
      eventType,
      id: this.id("evt"),
      object,
    });
    this.outbox.push({
      body,
      eventType,
      signature: webhookSignature(body, this.options.webhookSecret),
    });
  }

  /** The webhooks waiting to be delivered, oldest first. Emptied by reading. */
  takeDeliveries(): SignedDelivery[] {
    return this.outbox.splice(0, this.outbox.length);
  }

  private charge(subscription: FakeSubscription, amountCents: number): FakeTransaction {
    const transaction: FakeTransaction = {
      amountCents,
      createdAt: this.now(),
      currency: this.products.get(subscription.productId)?.currency ?? "USD",
      id: this.id("tran"),
      refundedCents: 0,
      status: "paid",
      subscriptionId: subscription.id,
      taxCents: Math.round((amountCents * (this.options.taxPercent ?? 0)) / 100),
    };
    this.transactions.set(transaction.id, transaction);
    subscription.lastTransactionId = transaction.id;
    subscription.updatedAt = this.now();
    return transaction;
  }

  // ---- What a buyer, the calendar and the dashboard do ----

  /**
   * The buyer pays. Returns where the browser is sent next: the success URL
   * with the signed parameters Creem appends.
   */
  completeCheckout(checkoutId: string, buyer: { country?: string; name?: string } = {}): string {
    const checkout = this.checkouts.get(checkoutId);
    const product = checkout ? this.products.get(checkout.productId) : undefined;
    if (!checkout || !product) {
      throw new Error(`No such checkout: ${checkoutId}`);
    }
    if (checkout.status === "completed") {
      throw new Error(`Checkout ${checkoutId} was already paid`);
    }
    let customer = checkout.customer.id ? this.customers.get(checkout.customer.id) : undefined;
    if (!customer) {
      customer = {
        country: buyer.country ?? "BE",
        email: checkout.customer.email ?? "buyer@example.com",
        id: this.id("cust"),
        name: buyer.name ?? "Test Buyer",
      };
      this.customers.set(customer.id, customer);
    }
    const start = this.now();
    const subscription: FakeSubscription = {
      canceledAt: null,
      createdAt: start,
      customerId: customer.id,
      id: this.id("sub"),
      lastTransactionId: null,
      metadata: checkout.metadata,
      periodEnd: addMonth(start),
      periodStart: start,
      productId: product.id,
      status: "active",
      updatedAt: start,
    };
    this.subscriptions.set(subscription.id, subscription);
    const transaction = this.charge(subscription, product.priceCents);
    checkout.status = "completed";

    const orderId = this.id("ord");
    // The checkout notice carries the subscription without its transaction;
    // the payment is on the order.
    const bare = this.subscriptionJson(subscription);
    delete bare["last_transaction"];
    delete bare["last_transaction_id"];
    this.queue("checkout.completed", {
      customer: this.customerJson(customer),
      id: checkout.id,
      metadata: checkout.metadata,
      mode: "test",
      object: "checkout",
      order: {
        amount: transaction.amountCents,
        amount_due: transaction.amountCents + transaction.taxCents,
        amount_paid: transaction.amountCents + transaction.taxCents,
        currency: transaction.currency,
        customer: customer.id,
        id: orderId,
        object: "order",
        product: product.id,
        status: "paid",
        tax_amount: transaction.taxCents,
        transaction: transaction.id,
        type: "recurring",
      },
      product: this.productJson(product),
      request_id: checkout.requestId,
      status: "completed",
      subscription: { ...bare, customer: customer.id, product: product.id },
    });
    this.queue("subscription.active", this.subscriptionJson(subscription));
    this.queue("subscription.paid", this.subscriptionJson(subscription));

    const params: [string, string][] = [
      ["checkout_id", checkout.id],
      ["order_id", orderId],
      ["customer_id", customer.id],
      ["subscription_id", subscription.id],
      ["product_id", product.id],
      ...(checkout.requestId ? ([["request_id", checkout.requestId]] as [string, string][]) : []),
    ];
    const url = new URL(checkout.successUrl);
    for (const [key, value] of params) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("signature", redirectSignature(params, this.options.apiKey));
    return url.toString();
  }

  private require(subscriptionId: string): FakeSubscription {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new Error(`No such subscription: ${subscriptionId}`);
    }
    return subscription;
  }

  /** The period ends: a scheduled cancellation takes effect, anything else renews. */
  endPeriod(subscriptionId: string): void {
    const subscription = this.require(subscriptionId);
    if (subscription.status === "scheduled_cancel") {
      subscription.status = "canceled";
      subscription.canceledAt = this.now();
      subscription.updatedAt = this.now();
      this.queue("subscription.canceled", this.subscriptionJson(subscription));
      return;
    }
    if (subscription.status !== "active" && subscription.status !== "past_due") {
      return;
    }
    const product = this.products.get(subscription.productId);
    subscription.periodStart = subscription.periodEnd;
    subscription.periodEnd = addMonth(subscription.periodStart);
    subscription.status = "active";
    this.charge(subscription, product?.priceCents ?? 0);
    this.queue("subscription.paid", this.subscriptionJson(subscription));
  }

  /** The renewal's card is declined; Creem starts retrying. */
  failRenewal(subscriptionId: string): void {
    const subscription = this.require(subscriptionId);
    subscription.status = "past_due";
    subscription.updatedAt = this.now();
    this.queue("subscription.past_due", this.subscriptionJson(subscription));
  }

  /** Ended outright: the retries ran out, or it was cancelled in the dashboard. */
  cancelNow(subscriptionId: string): void {
    const subscription = this.require(subscriptionId);
    subscription.status = "canceled";
    subscription.canceledAt = this.now();
    subscription.updatedAt = this.now();
    this.queue("subscription.canceled", this.subscriptionJson(subscription));
  }

  /** A refund from the dashboard, in full unless an amount (tax included) is given. */
  refund(transactionId: string, amountWithTaxCents?: number): string {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      throw new Error(`No such transaction: ${transactionId}`);
    }
    const amount = amountWithTaxCents ?? transaction.amountCents + transaction.taxCents;
    transaction.refundedCents += amount;
    transaction.status =
      transaction.refundedCents >= transaction.amountCents + transaction.taxCents
        ? "refunded"
        : "partialRefund";
    const refundId = this.id("ref");
    this.queue("refund.created", {
      id: refundId,
      mode: "test",
      object: "refund",
      reason: "requested_by_customer",
      refund_amount: amount,
      refund_currency: transaction.currency,
      status: "succeeded",
      subscription: transaction.subscriptionId,
      transaction: this.transactionJson(transaction),
    });
    return refundId;
  }

  // ---- The HTTP API ----

  readonly fetch: CreemFetch = async (input, init) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    this.calls.push(`${method} ${url.pathname}`);
    const json = (status: number, body: Json) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      });
    const fail = (status: number, message: string) =>
      json(status, { error: "Error", message: [message], status, trace_id: this.id("trace") });

    if (headers.get("x-api-key") !== this.options.apiKey) {
      return fail(403, "Invalid API key");
    }
    let body: Json = {};
    if (typeof init.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body) as Json;
      } catch {
        return fail(400, "Body is not JSON");
      }
    }
    const text = (value: unknown) => (typeof value === "string" ? value : "");

    if (method === "POST" && url.pathname === "/v1/products") {
      const key = headers.get("idempotency-key");
      const known = key ? this.idempotent.get(key) : undefined;
      const existing = known ? this.products.get(known) : undefined;
      if (existing) {
        return json(200, this.productJson(existing));
      }
      const priceCents = typeof body["price"] === "number" ? body["price"] : -1;
      if (!text(body["name"]) || (priceCents !== 0 && priceCents < 100)) {
        return fail(400, "price must be 0 or at least 100");
      }
      const product: FakeProduct = {
        currency: text(body["currency"]) || "USD",
        description: text(body["description"]),
        id: this.id("prod"),
        name: text(body["name"]),
        priceCents,
      };
      this.products.set(product.id, product);
      if (key) {
        this.idempotent.set(key, product.id);
      }
      return json(200, this.productJson(product));
    }

    if (method === "GET" && url.pathname === "/v1/products/search") {
      const items = [...this.products.values()].map((product) => ({
        ...this.productJson(product),
        status: this.archived.has(product.id) ? "archived" : "active",
      }));
      return json(200, {
        items,
        pagination: {
          current_page: 1,
          next_page: null,
          prev_page: null,
          total_pages: 1,
          total_records: items.length,
        },
      });
    }

    if (method === "POST" && url.pathname === "/v1/checkouts") {
      const product = this.products.get(text(body["product_id"]));
      if (!product) {
        return fail(404, "Product not found");
      }
      const customer = (body["customer"] ?? {}) as { email?: string; id?: string };
      const checkout: FakeCheckout = {
        customer,
        id: this.id("ch"),
        metadata: (body["metadata"] ?? {}) as Record<string, string>,
        productId: product.id,
        requestId: text(body["request_id"]) || null,
        status: "pending",
        successUrl: text(body["success_url"]),
      };
      this.checkouts.set(checkout.id, checkout);
      return json(200, {
        checkout_url: `${this.options.baseUrl ?? "https://checkout.creem.test"}/checkout/${checkout.id}`,
        id: checkout.id,
        mode: "test",
        object: "checkout",
        product: product.id,
        status: "pending",
      });
    }

    if (method === "GET" && url.pathname === "/v1/subscriptions") {
      const subscription = this.subscriptions.get(url.searchParams.get("subscription_id") ?? "");
      return subscription
        ? json(200, this.subscriptionJson(subscription))
        : fail(404, "Subscription not found");
    }

    const action = /^\/v1\/subscriptions\/([^/]+)\/(cancel|resume|upgrade)$/.exec(url.pathname);
    if (method === "POST" && action) {
      const subscription = this.subscriptions.get(decodeURIComponent(action[1] ?? ""));
      if (!subscription) {
        return fail(404, "Subscription not found");
      }
      if (action[2] === "cancel") {
        if (body["mode"] === "scheduled") {
          subscription.status = "scheduled_cancel";
          subscription.updatedAt = this.now();
          this.queue("subscription.scheduled_cancel", this.subscriptionJson(subscription));
        } else {
          this.cancelNow(subscription.id);
        }
      } else if (action[2] === "resume") {
        if (subscription.status !== "scheduled_cancel" && subscription.status !== "paused") {
          return fail(400, "Only a paused or scheduled-to-cancel subscription can be resumed");
        }
        subscription.status = "active";
        subscription.updatedAt = this.now();
        this.queue("subscription.active", this.subscriptionJson(subscription));
      } else {
        const target = this.products.get(text(body["product_id"]));
        const current = this.products.get(subscription.productId);
        if (!target || !current) {
          return fail(404, "Product not found");
        }
        subscription.productId = target.id;
        subscription.updatedAt = this.now();
        if (
          body["update_behavior"] === "proration-charge-immediately" &&
          target.priceCents > current.priceCents
        ) {
          const total = subscription.periodEnd.getTime() - subscription.periodStart.getTime();
          const left = Math.max(0, subscription.periodEnd.getTime() - this.now().getTime());
          const prorated = Math.round(((target.priceCents - current.priceCents) * left) / total);
          const before = subscription.lastTransactionId;
          this.charge(subscription, prorated);
          this.queue("subscription.paid", this.subscriptionJson(subscription));
          if (this.options.prorationReported === false) {
            // The charge exists and its notice is on the way, but the
            // subscription read back right now still names the old payment.
            const answer = this.subscriptionJson(subscription);
            const earlier = before ? this.transactions.get(before) : undefined;
            if (earlier) {
              answer["last_transaction"] = this.transactionJson(earlier);
              answer["last_transaction_id"] = earlier.id;
            }
            this.stale = { answer, subscriptionId: subscription.id };
            return json(200, answer);
          }
        } else {
          this.queue("subscription.update", this.subscriptionJson(subscription));
        }
      }
      return json(200, this.subscriptionJson(subscription));
    }

    if (method === "POST" && url.pathname === "/v1/customers/billing") {
      const customer = this.customers.get(text(body["customer_id"]));
      return customer
        ? json(200, {
            customer_portal_link: `${this.options.baseUrl ?? "https://portal.creem.test"}/portal/${customer.id}`,
          })
        : fail(404, "Customer not found");
    }

    return fail(404, `No such endpoint: ${method} ${url.pathname}`);
  };

  // With `prorationReported: false`, the next read of the subscription
  // after a charged plan change still shows the old payment.
  private stale: { answer: Json; subscriptionId: string } | null = null;

  /** Wraps `fetch` so the one stale read after an unreported charge is served. */
  readonly fetchWithLag: CreemFetch = async (input, init) => {
    const url = new URL(input);
    if (
      this.stale &&
      (init.method ?? "GET").toUpperCase() === "GET" &&
      url.pathname === "/v1/subscriptions" &&
      url.searchParams.get("subscription_id") === this.stale.subscriptionId
    ) {
      const answer = this.stale.answer;
      this.stale = null;
      this.calls.push("GET /v1/subscriptions");
      return new Response(JSON.stringify(answer), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }
    return this.fetch(input, init);
  };
}
