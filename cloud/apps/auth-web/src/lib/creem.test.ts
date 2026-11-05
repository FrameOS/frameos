import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cancelSubscription,
  centsToMicros,
  changeSubscriptionProduct,
  createCheckout,
  createMonthlyProduct,
  CreemError,
  creemSetup,
  getSubscription,
  parseSubscription,
  parseTransaction,
  redirectSignature,
  verifyRedirectSignature,
  verifyWebhookSignature,
  type CreemConfig,
  type CreemFetch,
} from "./creem";

const config: CreemConfig = {
  apiKey: "creem_test_key",
  baseUrl: "https://test-api.creem.io",
  mode: "test",
  webhookSecret: "whsec_test",
};

// Records what was sent and answers with a canned body.
function recorder(answer: unknown, status = 200) {
  const requests: { body: unknown; headers: Record<string, string>; method: string; url: string }[] = [];
  const fetchImpl: CreemFetch = async (url, init) => {
    requests.push({
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      method: init.method ?? "GET",
      url,
    });
    return new Response(JSON.stringify(answer), { status });
  };
  return { fetchImpl, requests };
}

describe("which Creem this deployment talks to", () => {
  it("is off without a key, and says nothing is wrong", () => {
    expect(creemSetup({})).toEqual({ config: null, mode: "test", problem: null });
  });

  it("is the test API by default", () => {
    const setup = creemSetup({ CREEM_API_KEY: "creem_test_abc", CREEM_WEBHOOK_SECRET: "whsec" });
    expect(setup.config).toEqual({
      apiKey: "creem_test_abc",
      baseUrl: "https://test-api.creem.io",
      mode: "test",
      webhookSecret: "whsec",
    });
  });

  it("goes live only when the mode and the key both say so", () => {
    const live = { CREEM_API_KEY: "creem_abc", CREEM_MODE: "live", CREEM_WEBHOOK_SECRET: "whsec" };
    expect(creemSetup(live).config?.baseUrl).toBe("https://api.creem.io");
    expect(creemSetup({ ...live, CREEM_MODE: "" }).problem).toMatch(/live key but CREEM_MODE is test/);
    expect(creemSetup({ ...live, CREEM_API_KEY: "creem_test_abc" }).problem).toMatch(/test key/);
    expect(creemSetup({ ...live, CREEM_MODE: "prod" }).problem).toMatch(/must be "test" or "live"/);
  });

  it("needs the webhook secret, because a payment is confirmed by webhook", () => {
    const setup = creemSetup({ CREEM_API_KEY: "creem_test_abc" });
    expect(setup.config).toBeNull();
    expect(setup.problem).toMatch(/CREEM_WEBHOOK_SECRET/);
  });

  it("lets only the test mode be pointed somewhere else", () => {
    const env = { CREEM_API_URL: "http://localhost:4010/", CREEM_WEBHOOK_SECRET: "whsec" };
    expect(creemSetup({ ...env, CREEM_API_KEY: "creem_test_abc" }).config?.baseUrl).toBe(
      "http://localhost:4010",
    );
    expect(
      creemSetup({ ...env, CREEM_API_KEY: "creem_abc", CREEM_MODE: "live" }).config?.baseUrl,
    ).toBe("https://api.creem.io");
  });
});

describe("the webhook signature", () => {
  const body = '{"id":"evt_1","eventType":"subscription.paid","object":{"id":"sub_1"}}';
  const signature = createHmac("sha256", "whsec_test").update(body).digest("hex");

  it("is the HMAC-SHA256 of the raw body under the webhook secret, in hex", () => {
    expect(verifyWebhookSignature(body, signature, "whsec_test")).toBe(true);
    expect(verifyWebhookSignature(body, signature.toUpperCase(), "whsec_test")).toBe(true);
  });

  it("fails on a changed body, another secret, or no signature", () => {
    expect(verifyWebhookSignature(body.replace("sub_1", "sub_2"), signature, "whsec_test")).toBe(false);
    expect(verifyWebhookSignature(body, signature, "whsec_other")).toBe(false);
    expect(verifyWebhookSignature(body, null, "whsec_test")).toBe(false);
    expect(verifyWebhookSignature(body, "", "whsec_test")).toBe(false);
    expect(verifyWebhookSignature(body, signature, "")).toBe(false);
  });
});

describe("the return from checkout", () => {
  // The documented recipe, written out by hand: the parameters in the order
  // they appear, joined with "|", then the API key as the salt.
  const expected = createHash("sha256")
    .update(
      "checkout_id=ch_1|order_id=ord_1|customer_id=cust_1|subscription_id=sub_1|product_id=prod_1|salt=creem_test_key",
    )
    .digest("hex");
  const query = `checkout_id=ch_1&order_id=ord_1&customer_id=cust_1&subscription_id=sub_1&product_id=prod_1&signature=${expected}`;

  it("is signed over its own parameters, in order, with the API key", () => {
    expect(verifyRedirectSignature(new URLSearchParams(query), "creem_test_key")).toBe(true);
  });

  it("leaves empty and null values out, as Creem does", () => {
    expect(
      redirectSignature(
        [
          ["checkout_id", "ch_1"],
          ["order_id", "ord_1"],
          ["customer_id", "cust_1"],
          ["subscription_id", "sub_1"],
          ["product_id", "prod_1"],
          ["request_id", ""],
          ["license_key", "null"],
        ],
        "creem_test_key",
      ),
    ).toBe(expected);
  });

  it("fails on a swapped subscription, a reordered query, or another key", () => {
    expect(
      verifyRedirectSignature(new URLSearchParams(query.replace("sub_1", "sub_2")), "creem_test_key"),
    ).toBe(false);
    expect(
      verifyRedirectSignature(
        new URLSearchParams(`order_id=ord_1&checkout_id=ch_1&customer_id=cust_1&subscription_id=sub_1&product_id=prod_1&signature=${expected}`),
        "creem_test_key",
      ),
    ).toBe(false);
    expect(verifyRedirectSignature(new URLSearchParams(query), "creem_test_other")).toBe(false);
    expect(verifyRedirectSignature(new URLSearchParams("checkout_id=ch_1"), "creem_test_key")).toBe(false);
  });
});

describe("reading Creem's objects", () => {
  it("takes a subscription with nested objects or bare ids", () => {
    const nested = parseSubscription({
      canceled_at: null,
      current_period_end_date: "2024-11-12T11:58:38.000Z",
      current_period_start_date: "2024-10-12T11:58:38.000Z",
      customer: { email: "customer@example.com", id: "cust_1" },
      id: "sub_1",
      last_transaction: {
        amount: 1000,
        amount_paid: 1210,
        created_at: 1728734327109,
        currency: "EUR",
        id: "tran_1",
        status: "paid",
        tax_amount: 210,
      },
      metadata: { account_id: "abc", ignored: 3 },
      product: { id: "prod_1", price: 1000 },
      status: "active",
    });
    expect(nested).toMatchObject({
      customerId: "cust_1",
      id: "sub_1",
      metadata: { account_id: "abc" },
      productId: "prod_1",
      status: "active",
    });
    expect(nested?.periodEnd?.toISOString()).toBe("2024-11-12T11:58:38.000Z");
    expect(nested?.lastTransaction).toMatchObject({
      amountPaidCents: 1210,
      currency: "EUR",
      id: "tran_1",
      taxCents: 210,
    });

    const bare = parseSubscription({ customer: "cust_2", id: "sub_2", product: "prod_2", status: "past_due" });
    expect(bare).toMatchObject({ customerId: "cust_2", lastTransaction: null, productId: "prod_2" });
    expect(parseSubscription({ status: "active" })).toBeNull();
    expect(parseSubscription("sub_1")).toBeNull();
  });

  it("works out what was paid when a notice only names the price and the tax", () => {
    expect(parseTransaction({ amount: 500, id: "tran_1", tax_amount: 105 })?.amountPaidCents).toBe(605);
    expect(parseTransaction({ amount: 500 })).toBeNull();
  });

  it("turns cents into micros", () => {
    expect(centsToMicros(1)).toBe(10_000n);
    expect(centsToMicros(2900)).toBe(29_000_000n);
  });
});

describe("the API calls", () => {
  it("creates a checkout that names the account and where to come back to", async () => {
    const { fetchImpl, requests } = recorder({ checkout_url: "https://checkout.creem.io/ch_1", id: "ch_1" });
    const checkout = await createCheckout(
      config,
      {
        customer: { email: "a@example.com" },
        metadata: { account_id: "acc" },
        productId: "prod_1",
        requestId: "req_1",
        successUrl: "https://cloud.example/return",
      },
      fetchImpl,
    );
    expect(checkout).toEqual({ id: "ch_1", url: "https://checkout.creem.io/ch_1" });
    expect(requests[0]).toMatchObject({
      body: {
        customer: { email: "a@example.com" },
        metadata: { account_id: "acc" },
        product_id: "prod_1",
        request_id: "req_1",
        success_url: "https://cloud.example/return",
      },
      method: "POST",
      url: "https://test-api.creem.io/v1/checkouts",
    });
    expect(requests[0]?.headers["x-api-key"]).toBe("creem_test_key");
  });

  it("makes a monthly USD product with tax on top, idempotently", async () => {
    const { fetchImpl, requests } = recorder({ id: "prod_9" });
    const id = await createMonthlyProduct(
      config,
      { description: "d", idempotencyKey: "k", name: "n", priceCents: 900 },
      fetchImpl,
    );
    expect(id).toBe("prod_9");
    expect(requests[0]?.body).toEqual({
      billing_period: "every-month",
      billing_type: "recurring",
      currency: "USD",
      description: "d",
      name: "n",
      price: 900,
      tax_category: "saas",
      tax_mode: "exclusive",
    });
    expect(requests[0]?.headers["idempotency-key"]).toBe("k");
  });

  it("reads a subscription by id", async () => {
    const { fetchImpl, requests } = recorder({ id: "sub_1", status: "active" });
    expect((await getSubscription(config, "sub_1", fetchImpl)).id).toBe("sub_1");
    expect(requests[0]?.url).toBe("https://test-api.creem.io/v1/subscriptions?subscription_id=sub_1");
  });

  it("cancels at the period end or at once", async () => {
    const { fetchImpl, requests } = recorder({ id: "sub_1", status: "scheduled_cancel" });
    await cancelSubscription(config, "sub_1", "scheduled", fetchImpl);
    await cancelSubscription(config, "sub_1", "immediate", fetchImpl);
    expect(requests.map((request) => request.body)).toEqual([
      { mode: "scheduled", onExecute: "cancel" },
      { mode: "immediate" },
    ]);
    expect(requests[0]?.url).toBe("https://test-api.creem.io/v1/subscriptions/sub_1/cancel");
  });

  it("charges the difference for a larger plan and nothing for a smaller one", async () => {
    const { fetchImpl, requests } = recorder({ id: "sub_1", status: "active" });
    await changeSubscriptionProduct(config, "sub_1", "prod_big", "charge", fetchImpl);
    await changeSubscriptionProduct(config, "sub_1", "prod_small", "none", fetchImpl);
    expect(requests.map((request) => request.body)).toEqual([
      { product_id: "prod_big", update_behavior: "proration-charge-immediately" },
      { product_id: "prod_small", update_behavior: "proration-none" },
    ]);
  });

  it("turns a refusal into an error that carries Creem's words", async () => {
    const { fetchImpl } = recorder({ message: ["product_id must be a string"], status: 400 }, 400);
    await expect(getSubscription(config, "sub_1", fetchImpl)).rejects.toThrow(
      /failed \(400\): product_id must be a string/,
    );
    const down: CreemFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const error = await getSubscription(config, "sub_1", down).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CreemError);
    expect((error as CreemError).status).toBe(0);
  });
});
