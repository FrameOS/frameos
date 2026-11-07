import { describe, expect, it } from "vitest";
import { feeMicrosIn, priceLookupKey, redactPayload } from "./billing-provider";
import {
  parseInvoice,
  parseSubscription,
  signWebhookForTests,
  stripeApiVersion,
  stripeSetup,
  verifyWebhook,
} from "./stripe";
import { parseStripeForm } from "../test/stripe-fake";

const keys = {
  STRIPE_SECRET_KEY: "sk_test_abc",
  STRIPE_WEBHOOK_SECRET: "whsec_abc",
};

describe("stripeSetup", () => {
  it("is off without a key, and says nothing is wrong", () => {
    expect(stripeSetup({})).toEqual({ config: null, mode: "test", problem: null });
  });

  it("takes a test key in test mode, with tax on and prices before tax", () => {
    const setup = stripeSetup(keys);
    expect(setup.config).toMatchObject({
      allowPromotionCodes: false,
      apiBase: null,
      automaticTax: true,
      mode: "test",
      taxBehavior: "exclusive",
      testClocks: false,
    });
  });

  it("refuses a key whose mode disagrees with STRIPE_MODE", () => {
    expect(stripeSetup({ ...keys, STRIPE_SECRET_KEY: "sk_live_abc" }).problem).toMatch(/live key but STRIPE_MODE is test/);
    expect(stripeSetup({ ...keys, STRIPE_MODE: "live" }).problem).toMatch(/test key but STRIPE_MODE is live/);
    expect(stripeSetup({ ...keys, STRIPE_MODE: "live", STRIPE_SECRET_KEY: "rk_live_abc" }).config?.mode).toBe("live");
  });

  it("refuses a publishable key, a missing webhook secret and a nonsense mode", () => {
    expect(stripeSetup({ ...keys, STRIPE_SECRET_KEY: "pk_test_abc" }).problem).toMatch(/publishable/);
    expect(stripeSetup({ ...keys, STRIPE_WEBHOOK_SECRET: "" }).problem).toMatch(/not set/);
    expect(stripeSetup({ ...keys, STRIPE_WEBHOOK_SECRET: "abc" }).problem).toMatch(/whsec_/);
    expect(stripeSetup({ ...keys, STRIPE_MODE: "prod" }).problem).toMatch(/"test" or "live"/);
    expect(stripeSetup({ ...keys, STRIPE_TAX_BEHAVIOR: "included" }).problem).toMatch(/exclusive/);
  });

  it("points only test mode elsewhere, and keeps test clocks to test mode", () => {
    const test = stripeSetup({ ...keys, STRIPE_API_URL: "http://127.0.0.1:4242", STRIPE_TEST_CLOCKS: "1" });
    expect(test.config?.apiBase).toEqual({ host: "127.0.0.1", port: 4242, protocol: "http" });
    expect(test.config?.testClocks).toBe(true);
    const live = stripeSetup({
      ...keys,
      STRIPE_API_URL: "http://127.0.0.1:4242",
      STRIPE_MODE: "live",
      STRIPE_SECRET_KEY: "sk_live_abc",
      STRIPE_TEST_CLOCKS: "1",
    });
    expect(live.config?.apiBase).toBeNull();
    expect(live.config?.testClocks).toBe(false);
  });

  it("can turn Stripe Tax off and prices to tax-inclusive", () => {
    const setup = stripeSetup({ ...keys, STRIPE_AUTOMATIC_TAX: "0", STRIPE_TAX_BEHAVIOR: "inclusive" });
    expect(setup.config?.automaticTax).toBe(false);
    expect(setup.config?.taxBehavior).toBe("inclusive");
  });

  it("pins an API version", () => {
    expect(stripeApiVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.[a-z]+$/);
  });
});

describe("reading Stripe's objects", () => {
  const invoice = {
    amount_paid: 1089,
    billing_reason: "subscription_cycle",
    currency: "usd",
    customer: "cus_1",
    id: "in_1",
    lines: {
      data: [
        {
          amount: 900,
          period: { end: 1_767_225_600, start: 1_764_547_200 },
          pricing: { price_details: { price: "price_9" }, type: "price_details" },
        },
      ],
    },
    number: "ABC-0001",
    parent: { subscription_details: { subscription: "sub_1" }, type: "subscription_details" },
    status: "paid",
    status_transitions: { paid_at: 1_764_547_300 },
    total: 1089,
    total_taxes: [{ amount: 189, tax_behavior: "exclusive", type: "tax_rate_details" }],
  };

  it("reads a paid invoice: what it bought, for how long, and the tax in it", () => {
    expect(parseInvoice(invoice)).toEqual({
      amountPaidCents: 1089,
      billingReason: "subscription_cycle",
      currency: "USD",
      customerId: "cus_1",
      hostedInvoiceUrl: null,
      id: "in_1",
      number: "ABC-0001",
      paid: true,
      paidAt: new Date(1_764_547_300_000),
      periodEnd: new Date(1_767_225_600_000),
      periodStart: new Date(1_764_547_200_000),
      priceId: "price_9",
      status: "paid",
      subscriptionId: "sub_1",
      taxCents: 189,
    });
  });

  it("takes the new plan's line of a prorated upgrade, and the tax share of a part paid by credit", () => {
    const upgrade = parseInvoice({
      ...invoice,
      amount_paid: 121,
      lines: {
        data: [
          { amount: -250, period: { end: 2, start: 1 }, pricing: { price_details: { price: "price_5" } } },
          { amount: 450, period: { end: 2, start: 1 }, pricing: { price_details: { price: "price_9" } } },
        ],
      },
      total: 242,
      total_taxes: [{ amount: 42 }],
    });
    expect(upgrade?.priceId).toBe("price_9");
    expect(upgrade?.taxCents).toBe(21);
  });

  it("tells an active subscription with a cancellation scheduled apart", () => {
    const subscription = {
      cancel_at: null,
      cancel_at_period_end: true,
      customer: { id: "cus_1" },
      id: "sub_1",
      items: { data: [{ current_period_end: 2000, current_period_start: 1000, id: "si_1", price: { id: "price_5" } }] },
      latest_invoice: "in_1",
      metadata: { frameos_account_id: "x", other: 5 },
      pending_update: null,
      status: "active",
    };
    expect(parseSubscription(subscription)).toMatchObject({
      cancelAt: new Date(2_000_000),
      customerId: "cus_1",
      itemId: "si_1",
      latestInvoice: null,
      latestInvoiceId: "in_1",
      metadata: { frameos_account_id: "x" },
      periodEnd: new Date(2_000_000),
      priceId: "price_5",
      status: "scheduled_cancel",
      stripeStatus: "active",
    });
    expect(parseSubscription({ ...subscription, cancel_at_period_end: false })?.status).toBe("active");
    expect(parseSubscription({ ...subscription, status: "past_due" })?.status).toBe("past_due");
    expect(parseSubscription({ id: "" })).toBeNull();
  });
});

describe("webhook signatures", () => {
  it("accepts Stripe's signature over the raw body, and nothing else", () => {
    const body = JSON.stringify({ data: { object: {} }, id: "evt_1", livemode: false, type: "invoice.paid" });
    const signature = signWebhookForTests(body, "whsec_abc");
    expect(verifyWebhook(body, signature, "whsec_abc")?.id).toBe("evt_1");
    expect(verifyWebhook(body, signature, "whsec_other")).toBeNull();
    expect(verifyWebhook(`${body} `, signature, "whsec_abc")).toBeNull();
    expect(verifyWebhook(body, null, "whsec_abc")).toBeNull();
    const old = signWebhookForTests(body, "whsec_abc", Math.floor(Date.now() / 1000) - 600);
    expect(verifyWebhook(body, old, "whsec_abc")).toBeNull();
  });
});

describe("what is kept of a notice", () => {
  it("keeps ids and amounts and drops the customer's details", () => {
    const kept = redactPayload({
      data: {
        object: {
          amount: 500,
          billing_details: { email: "a@b.c", name: "A" },
          customer: "cus_1",
          customer_details: { address: { city: "Leuven" }, email: "a@b.c" },
          customer_email: "a@b.c",
          id: "cs_1",
          payment_method_details: { card: { brand: "visa", country: "BE", last4: "4242" } },
        },
      },
    });
    expect(kept).toEqual({
      data: {
        object: {
          amount: 500,
          customer: "cus_1",
          id: "cs_1",
          payment_method_details: { card: { brand: "visa", country: "BE" } },
        },
      },
    });
  });
});

describe("money", () => {
  it("converts a fee settled in euros back to dollars at Stripe's rate", () => {
    expect(feeMicrosIn({ amountMinor: 45, balanceTransactionId: "txn", currency: "USD", exchangeRate: null }, "USD")).toBe(450_000n);
    expect(feeMicrosIn({ amountMinor: 37, balanceTransactionId: "txn", currency: "EUR", exchangeRate: 0.92 }, "USD")).toBe(402_174n);
    expect(feeMicrosIn({ amountMinor: 37, balanceTransactionId: "txn", currency: "EUR", exchangeRate: null }, "USD")).toBeNull();
  });

  it("names a price by everything that makes it what it is", () => {
    expect(priceLookupKey("private-5", "USD", 500, "exclusive")).toBe("frameos-cloud:private-5:usd:500:month:exclusive");
  });
});

describe("the stand-in's form parsing", () => {
  it("reads Stripe's indexed brackets back into objects and arrays", () => {
    expect(
      parseStripeForm("items[0][id]=si_1&items[0][price]=price_2&expand[0]=latest_invoice&metadata[a]=b&cancel_at_period_end=true"),
    ).toEqual({
      cancel_at_period_end: "true",
      expand: ["latest_invoice"],
      items: [{ id: "si_1", price: "price_2" }],
      metadata: { a: "b" },
    });
  });
});
