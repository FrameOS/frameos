// Paid plans through Stripe (cloud/docs/billing.md): the routes a buyer
// touches, the webhook, the nightly reconcile and account deletion, against
// a stand-in for Stripe's API served over HTTP (../stripe-fake.ts), so the
// SDK's real requests are what it answers. The ledger package proves the
// accounting of a payment; this proves that what Stripe says ends up as the
// right plan and the right books, once, in any order.
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accounts,
  auditEvents,
  createDb,
  providerEvents,
  providerPayments,
  providerProducts,
  providerSubscriptions,
  subscriptionPeriods,
  subscriptions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import {
  accountBalanceMicros,
  checkLedgerIntegrity,
  customerReceivableCode,
  readAccountPlan,
  systemAccountCodes,
} from "@frameos-cloud/ledger";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteAccountAsAdmin } from "../../../app/api/admin/users/[accountId]/route";
import { PUT as putCustomerPlan } from "../../../app/api/admin/billing/customers/[accountId]/plan/route";
import { POST as postSync } from "../../../app/api/admin/billing/plans/route";
import { POST as postCheckout } from "../../../app/api/account/plan/checkout/route";
import { GET as getCheckoutReturn } from "../../../app/api/account/plan/checkout/return/route";
import { GET as getInvoices } from "../../../app/api/account/plan/invoices/route";
import { POST as postPortal } from "../../../app/api/account/plan/portal/route";
import { GET as getPlan, PUT as putPlan } from "../../../app/api/account/plan/route";
import { POST as postWebhook } from "../../../app/api/webhooks/stripe/route";
import { GET as getPricing } from "../../../app/pricing/route";
import {
  applySubscription,
  cancelForErasure,
  checkoutOpenTo,
  priceLookupKey,
  reconcileSubscriptions,
  syncPlans,
} from "../../lib/billing-provider";
import { planEvents } from "../../lib/plan-notifications";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";
import { retrieveSubscription, signWebhookForTests, stripeSetup, webhookEvents } from "../../lib/stripe";
import { serveStripeFake, StripeFake, type FakeDelivery, type RunningStripeFake, type StripeFakeOptions } from "../stripe-fake";

const cookieJar = vi.hoisted(() => new Map<string, string>());
const captured = vi.hoisted(
  () => [] as { distinctId: string; event: string; properties: Record<string, unknown> }[],
);

// What reaches PostHog, and from there the reports channel on Discord.
vi.mock("../../lib/posthog-capture", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  capturePostHogEvent: async (event: string, distinctId: string, properties: Record<string, unknown>) => {
    captured.push({ distinctId, event, properties });
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers(),
}));

const baseUrl = "http://localhost:3000";
const issuer = "https://accounts.google.com";
const secretKey = "sk_test_integration";
const webhookSecret = "whsec_integration";
const db = createDb();
let userCounter = 0;
let fake: StripeFake;
let server: RunningStripeFake;
let clock: Date;

beforeAll(async () => {
  server = await serveStripeFake(() => fake);
});

afterAll(async () => {
  await server.close();
  await db.$client.end({ timeout: 5 });
});

async function seedChart() {
  await db.execute(sql`
    INSERT INTO ledger_account_groups ("code", "name", "sort_order") VALUES
      ('assets', 'Assets', 10), ('liabilities', 'Liabilities', 20),
      ('equity', 'Equity', 30), ('revenue', 'Revenue', 40),
      ('cost_of_revenue', 'Cost of revenue', 50),
      ('operating_expenses', 'Operating expenses', 60)
    ON CONFLICT ("code") DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO ledger_accounts ("code", "type", "normal_side", "group_id")
    SELECT v.code, v.type, v.normal_side, g.id FROM (VALUES
      ('asset:psp:main', 'asset', 'debit', 'assets'),
      ('liability:deferred:subscriptions', 'liability', 'credit', 'liabilities'),
      ('liability:sales_tax', 'liability', 'credit', 'liabilities'),
      ('revenue:subscriptions', 'revenue', 'credit', 'revenue'),
      ('expense:psp_fees', 'expense', 'debit', 'cost_of_revenue')
    ) AS v(code, type, normal_side, group_code)
    JOIN ledger_account_groups g ON g.code = v.group_code
    ON CONFLICT ("code") DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO billing_plans ("code", "name", "price_micros", "margin_basis_points", "entitlements")
    VALUES ('payg', 'Free', 0, 10000, '{"frames": 20}'::jsonb)
    ON CONFLICT ("code") DO NOTHING
  `);
}

function useFake(options: Partial<StripeFakeOptions> = {}) {
  fake = new StripeFake({
    // No card fee unless a test asks: the books below are about the plan.
    feeFixed: 0,
    feePercent: 0,
    now: () => clock,
    webhookSecret,
    ...options,
  });
  fake.webhookEndpoints = [
    {
      api_version: "2026-09-30.endive",
      enabled_events: [...webhookEvents],
      id: "we_fake",
      object: "webhook_endpoint",
      status: "enabled",
      url: `${baseUrl}/api/webhooks/stripe`,
    },
  ];
}

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  captured.length = 0;
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "schema_migrations")
    .map((name) => `"${name}"`);
  if (names.length > 0) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(", ")} CASCADE`));
  }
  await seedChart();
  process.env.STRIPE_SECRET_KEY = secretKey;
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  process.env.STRIPE_API_URL = server.url;
  // Post test payments, so the books can be checked.
  process.env.STRIPE_TEST_LEDGER = "1";
  delete process.env.STRIPE_MODE;
  clock = new Date();
  useFake();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_API_URL",
    "STRIPE_TEST_LEDGER",
    "STRIPE_MODE",
    "STRIPE_TEST_OPEN",
    "STRIPE_CHECKOUT_OPEN",
    "STRIPE_TEST_CLOCKS",
    "STRIPE_AUTOMATIC_TAX",
  ]) {
    delete process.env[key];
  }
});

function config() {
  const setup = stripeSetup();
  if (!setup.config) {
    throw new Error(setup.problem ?? "Stripe is not configured");
  }
  return setup.config;
}

const portalUrls = {
  headline: "FrameOS Cloud",
  privacyPolicyUrl: `${baseUrl}/legal/privacy`,
  returnUrl: `${baseUrl}/account/usage`,
  termsOfServiceUrl: `${baseUrl}/legal/terms`,
  webhookUrl: `${baseUrl}/api/webhooks/stripe`,
};

async function signIn({ superadmin = false, verified = true } = {}) {
  userCounter += 1;
  const providerSubject = `plan-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Plan Tester ${userCounter}`,
    email: `plan-${userCounter}@example.com`,
    emailVerified: verified,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  if (superadmin) {
    await db.update(accounts).set({ isSuperadmin: true }).where(eq(accounts.id, accountId));
  }
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

function jsonRequest(method: string, path: string, body?: Record<string, unknown>) {
  return new NextRequest(new URL(path, baseUrl), {
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", origin: baseUrl },
    method,
  });
}

function send(body: string, signature: string) {
  return postWebhook(
    new NextRequest(new URL("/api/webhooks/stripe", baseUrl), {
      body,
      headers: { "content-type": "application/json", "stripe-signature": signature },
      method: "POST",
    }),
  );
}

async function deliver(options: { only?: string[]; reverse?: boolean } = {}) {
  const statuses: number[] = [];
  let deliveries: FakeDelivery[] = fake.takeDeliveries();
  if (options.reverse) {
    deliveries = [...deliveries].reverse();
  }
  for (const delivery of deliveries) {
    if (options.only && !options.only.includes(delivery.eventType)) {
      continue;
    }
    statuses.push((await send(delivery.body, delivery.signature)).status);
  }
  return statuses;
}

async function startCheckout(plan: string) {
  const response = await postCheckout(jsonRequest("POST", "/api/account/plan/checkout", { plan }));
  const body = (await response.json()) as { checkout_url?: string; error?: string };
  return { body, sessionId: body.checkout_url?.split("/").pop() ?? "", status: response.status };
}

// Sync the plans and buy one, webhooks delivered.
async function buy(plan: string, accountId: string) {
  await syncPlans(db, config(), portalUrls);
  const { sessionId } = await startCheckout(plan);
  fake.completeCheckout(sessionId);
  await deliver();
  const [row] = await db
    .select()
    .from(providerSubscriptions)
    .where(eq(providerSubscriptions.accountId, accountId));
  if (!row) {
    throw new Error("The purchase left no Stripe subscription");
  }
  return row.subscriptionId;
}

async function plan() {
  const response = await getPlan(new NextRequest(new URL("/api/account/plan", baseUrl)));
  return (await response.json()) as {
    billing: {
      checkout: boolean;
      manage: boolean;
      mode: string | null;
      prices_exclude_tax: boolean;
      subscription: {
        cancel_at: string | null;
        past_due: boolean;
        plan_code: string | null;
        renews_at: string | null;
        status: string;
      } | null;
    };
    catalog: { groups: { available: boolean; key: string; stops: { code: string; current: boolean; purchasable: boolean }[] }[] };
    next_plan_code: string | null;
    plan: { code: string };
  };
}

async function books(accountId: string) {
  return {
    deferred: await accountBalanceMicros(db, systemAccountCodes.deferredSubscriptions),
    fees: await accountBalanceMicros(db, systemAccountCodes.pspFees),
    psp: await accountBalanceMicros(db, systemAccountCodes.psp),
    receivable: await accountBalanceMicros(db, customerReceivableCode(accountId)),
    salesTax: await accountBalanceMicros(db, systemAccountCodes.salesTax),
  };
}

const dollars = (value: number) => BigInt(Math.round(value * 1_000_000));
const nothingElse = { fees: 0n, receivable: 0n, salesTax: 0n };

function latestInvoiceOf(subscriptionId: string) {
  return fake.subscriptions.get(subscriptionId)!.latest_invoice!;
}

describe("syncing the plans", () => {
  it("makes every self-serve stop buyable, once, and sets up the portal", async () => {
    await signIn({ superadmin: true });
    const first = await postSync(jsonRequest("POST", "/api/admin/billing/plans"));
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      checks: {
        tax_status: string;
        webhook: { api_version: string | null; enabled: boolean; found: boolean; missing_events: string[] };
      };
      plans: { code: string; created: boolean }[];
      provider: string;
    };
    expect(body.provider).toBe("stripe");
    expect(body.plans.map((entry) => [entry.code, entry.created])).toEqual([
      ["private-2", true],
      ["private-5", true],
      ["private-9", true],
      ["private-29", true],
      ["business-49", true],
      ["business-99", true],
      ["business-199", true],
      ["business-499", true],
    ]);
    expect(body.checks).toEqual({
      tax_status: "active",
      webhook: { api_version: null, enabled: true, found: true, missing_events: [] },
    });
    // One product per group, one monthly price per stop, before tax.
    expect(fake.products.size).toBe(2);
    const prices = [...fake.prices.values()];
    expect(prices.map((price) => price.unit_amount).sort((a, b) => a - b)).toEqual([
      200, 500, 900, 2900, 4900, 9900, 19900, 49900,
    ]);
    expect(prices.every((price) => price.tax_behavior === "exclusive" && price.recurring.interval === "month")).toBe(true);
    expect(prices.map((price) => price.lookup_key)).toContain(priceLookupKey("private-5", "USD", 500, "exclusive"));
    expect(prices.map((price) => price.lookup_key)).toContain(priceLookupKey("business-499", "USD", 49900, "exclusive"));
    const products = [...fake.products.values()];
    const taxCodeOf = (group: string) =>
      products.find((product) => (product["metadata"] as Record<string, string>)["frameos_cloud_group"] === group)?.[
        "tax_code"
      ];
    expect(taxCodeOf("private")).toBe("txcd_10103000");
    expect(taxCodeOf("business")).toBe("txcd_10103001");
    // Each stop's price sits under its own group's product.
    const productOfPrice = (amount: number) =>
      prices.find((price) => price.unit_amount === amount)?.product;
    expect(productOfPrice(4900)).toBe(productOfPrice(49900));
    expect(productOfPrice(4900)).not.toBe(productOfPrice(2900));
    expect(fake.portalConfigurations.size).toBe(1);

    const second = await postSync(jsonRequest("POST", "/api/admin/billing/plans"));
    const again = (await second.json()) as { plans: { created: boolean }[] };
    expect(again.plans.every((entry) => !entry.created)).toBe(true);
    expect(fake.prices.size).toBe(8);
    expect(fake.products.size).toBe(2);
    expect(fake.portalConfigurations.size).toBe(1);
    expect(await db.select().from(providerProducts)).toHaveLength(8);

    const [row] = await db.execute<{ entitlements: Record<string, number> }>(
      sql`select entitlements from billing_plans where code = 'private-5'`,
    );
    expect(row?.entitlements.frames).toBe(60);
    expect(row?.entitlements.cloud_rendered_frames).toBe(5);
  });

  it("says what is missing at Stripe: tax and the webhook's events", async () => {
    await signIn({ superadmin: true });
    fake.taxStatus = "pending";
    fake.webhookEndpoints = [
      {
        api_version: "2023-10-16",
        enabled_events: ["invoice.paid"],
        id: "we_1",
        object: "webhook_endpoint",
        status: "enabled",
        url: `${baseUrl}/api/webhooks/stripe`,
      },
    ];
    const body = (await (await postSync(jsonRequest("POST", "/api/admin/billing/plans"))).json()) as {
      checks: { tax_status: string; webhook: { api_version: string | null; missing_events: string[] } };
    };
    expect(body.checks.tax_status).toBe("pending");
    expect(body.checks.webhook.api_version).toBe("2023-10-16");
    expect(body.checks.webhook.missing_events).toContain("customer.subscription.updated");
    expect(body.checks.webhook.missing_events).not.toContain("invoice.paid");
  });

  it("adopts prices Stripe already has, and replaces one that is archived", async () => {
    await syncPlans(db, config(), portalUrls);
    const first = await db.select().from(providerProducts);
    expect(first).toHaveLength(8);

    // Another deployment on the same Stripe account (a fresh database)
    // sells the same eight prices instead of making eight more.
    await db.delete(providerProducts);
    const adopted = await syncPlans(db, config(), portalUrls);
    expect(adopted.plans.every((entry) => !entry.created)).toBe(true);
    expect(fake.prices.size).toBe(8);
    expect((await db.select().from(providerProducts)).map((row) => row.productId).sort()).toEqual(
      first.map((row) => row.productId).sort(),
    );

    // One is archived in the dashboard: the next sync makes it again, takes
    // its lookup key over, and stops selling the old one.
    const gone = first.find((row) => row.planCode === "private-9")!;
    fake.archivePrice(gone.productId);
    const repaired = await syncPlans(db, config(), portalUrls);
    expect(repaired.plans.filter((entry) => entry.created).map((entry) => entry.code)).toEqual(["private-9"]);
    expect(fake.prices.get(gone.productId)?.lookup_key).toBeNull();
    const rows = await db.select().from(providerProducts);
    const active = rows.filter((row) => row.planCode === "private-9" && row.active);
    expect(active).toHaveLength(1);
    expect(active[0]?.productId).not.toBe(gone.productId);
    // A subscription still on the old price resolves to its plan.
    expect(rows.find((row) => row.productId === gone.productId)?.active).toBe(false);
  });

  it("writes the plan rows alone when Stripe is not set up, and is the operators' only", async () => {
    await signIn();
    expect((await postSync(jsonRequest("POST", "/api/admin/billing/plans"))).status).toBe(403);

    delete process.env.STRIPE_SECRET_KEY;
    await signIn({ superadmin: true });
    const response = await postSync(jsonRequest("POST", "/api/admin/billing/plans"));
    const body = (await response.json()) as { plans: { code: string }[]; provider: string | null };
    expect(body.provider).toBeNull();
    expect(body.plans).toHaveLength(8);
    expect(fake.prices.size).toBe(0);
  });
});

describe("buying a plan", () => {
  it("puts the account on the plan when Stripe says it was paid", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), portalUrls);
    expect((await plan()).catalog.groups.map((group) => [group.key, group.available])).toEqual([
      ["free", true],
      ["private", true],
      ["business", true],
    ]);
    expect((await plan()).billing.prices_exclude_tax).toBe(true);

    const checkout = await startCheckout("private-5");
    expect(checkout.status).toBe(200);
    expect(checkout.body.checkout_url).toBe(`https://checkout.stripe.fake/c/pay/${checkout.sessionId}`);
    // The checkout names the account on the session and on the subscription
    // it makes, collects a full address and VAT numbers, and keeps dollars.
    const session = fake.checkouts.get(checkout.sessionId)!;
    expect(session["metadata"]).toEqual({ frameos_account_id: accountId, frameos_plan_code: "private-5" });
    expect(session["subscription_metadata"]).toEqual(session["metadata"]);
    expect(session["client_reference_id"]).toBe(accountId);
    expect(session["automatic_tax"]).toEqual({ enabled: true });
    expect(session["adaptive_pricing"]).toEqual({ enabled: false });
    expect(String(session["success_url"])).toBe(
      `${baseUrl}/api/account/plan/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
    );
    expect((await plan()).plan.code).toBe("payg");

    fake.completeCheckout(checkout.sessionId);
    expect(await deliver()).toEqual([200, 200, 200]);

    const after = await plan();
    expect(after.plan.code).toBe("private-5");
    expect(after.billing.subscription?.status).toBe("active");
    expect(after.billing.subscription?.renews_at).toBeTruthy();
    expect(after.billing.manage).toBe(true);
    // Three notices about one payment: one period, one payment, nothing owed.
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(1);
    expect(await db.select().from(providerPayments).where(eq(providerPayments.kind, "payment"))).toHaveLength(1);
    expect(await books(accountId)).toEqual({ ...nothingElse, deferred: dollars(5), psp: dollars(5) });
    expect(await checkLedgerIntegrity(db)).toEqual([]);
    const events = await db.select().from(providerEvents);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.processedAt && event.accountId === accountId)).toBe(true);
    // What we keep of a notice has no name or email in it.
    const kept = JSON.stringify(events.map((event) => event.payload));
    expect(kept).not.toContain("@example.com");
    expect(kept).not.toContain("A Buyer");
  });

  it("books the VAT Stripe added as owed, and the price as revenue to come", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    await buy("private-9", accountId);
    const [payment] = await db.select().from(providerPayments).where(eq(providerPayments.kind, "payment"));
    expect(payment?.amountMicros).toBe(dollars(9));
    expect(payment?.taxMicros).toBe(dollars(1.89));
    expect(payment?.taxRemittedBy).toBe("us");
    expect(await books(accountId)).toEqual({
      ...nothingElse,
      deferred: dollars(9),
      psp: dollars(10.89),
      salesTax: dollars(1.89),
    });
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("books Stripe's fee, in dollars at the rate a euro balance was credited at", async () => {
    // A $9 charge settles as €8.28 at 0.92; 1.5% + €0.25 of that is €0.37,
    // which is $0.402174 at the same rate.
    useFake({ exchangeRate: 0.92, feeFixed: 25, feePercent: 1.5, settlementCurrency: "eur" });
    const accountId = await signIn();
    await buy("private-9", accountId);
    const [payment] = await db.select().from(providerPayments).where(eq(providerPayments.kind, "payment"));
    expect(payment?.paymentRef).toMatch(/^ch_/);
    const [fee] = await db.select().from(providerPayments).where(eq(providerPayments.kind, "fee"));
    expect(fee?.amountMicros).toBe(402_174n);
    expect(fee?.paymentRef).toBe(payment?.paymentRef);
    expect(fee?.details).toMatchObject({ settlement: { amount_minor: 37, currency: "EUR", exchange_rate: 0.92 } });
    expect(await books(accountId)).toEqual({
      ...nothingElse,
      deferred: dollars(9),
      fees: 402_174n,
      psp: dollars(9) - 402_174n,
    });
    // A second notice about the same payment books no second fee.
    await reconcileSubscriptions(db, config());
    expect(await db.select().from(providerPayments).where(eq(providerPayments.kind, "fee"))).toHaveLength(1);
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("reads a paid invoice back in its own API version, whatever the notice carried", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    fake.completeCheckout(sessionId);
    const paid = fake.takeDeliveries().find((delivery) => delivery.eventType === "invoice.paid")!;
    // An endpoint on the 2023 API version: no total_taxes, the subscription
    // at the top, a line's price as an object.
    const event = JSON.parse(paid.body) as { data: { object: Record<string, unknown> } };
    const invoice = event.data.object;
    delete invoice["total_taxes"];
    delete invoice["parent"];
    invoice["subscription"] = [...fake.subscriptions.keys()][0];
    invoice["tax"] = 105;
    const body = JSON.stringify(event);
    expect((await send(body, signWebhookForTests(body, webhookSecret))).status).toBe(200);
    const [payment] = await db.select().from(providerPayments).where(eq(providerPayments.kind, "payment"));
    expect(payment?.amountMicros).toBe(dollars(5));
    expect(payment?.taxMicros).toBe(dollars(1.05));
    expect((await books(accountId)).salesTax).toBe(dollars(1.05));
  });

  it("applies a retried notice once and refuses a forged or stale one", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-2");
    fake.completeCheckout(sessionId);
    const deliveries = fake.takeDeliveries();
    const paid = deliveries.find((delivery) => delivery.eventType === "invoice.paid")!;
    expect((await send(paid.body, "t=1,v1=" + "0".repeat(64))).status).toBe(401);
    expect((await send(paid.body.replace('"amount_paid":200', '"amount_paid":2900'), paid.signature)).status).toBe(401);
    // Signed properly, but long ago: a replay.
    const old = signWebhookForTests(paid.body, webhookSecret, Math.floor(Date.now() / 1000) - 3600);
    expect((await send(paid.body, old)).status).toBe(401);
    expect((await plan()).plan.code).toBe("payg");

    expect((await send(paid.body, paid.signature)).status).toBe(200);
    const retry = await send(paid.body, paid.signature);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ duplicate: true, ok: true });
    expect(await db.select().from(providerPayments).where(eq(providerPayments.kind, "payment"))).toHaveLength(1);
    expect((await books(accountId)).psp).toBe(dollars(2));
  });

  it("does the same whatever order the notices come in", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    fake.completeCheckout(sessionId);
    expect(await deliver({ reverse: true })).toEqual([200, 200, 200]);
    expect((await plan()).plan.code).toBe("private-5");
    expect(await books(accountId)).toEqual({ ...nothingElse, deferred: dollars(5), psp: dollars(5) });
  });

  it("grants the plan on the return from checkout, before any webhook", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    const returnUrl = fake.completeCheckout(sessionId);
    expect(returnUrl).toBe(`${baseUrl}/api/account/plan/checkout/return?session_id=${sessionId}`);

    const response = await getCheckoutReturn(new NextRequest(returnUrl));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${baseUrl}/account/usage?checkout=active`);
    expect((await plan()).plan.code).toBe("private-5");

    // The webhooks arrive afterwards and change nothing.
    expect(await deliver()).toEqual([200, 200, 200]);
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(1);
    expect((await books(accountId)).psp).toBe(dollars(5));
  });

  it("does not believe a return link with a made-up or unpaid session", async () => {
    await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    const made = await getCheckoutReturn(
      new NextRequest(`${baseUrl}/api/account/plan/checkout/return?session_id=cs_test_madeup`),
    );
    expect(made.headers.get("location")).toBe(`${baseUrl}/account/usage?checkout=pending`);
    const garbage = await getCheckoutReturn(
      new NextRequest(`${baseUrl}/api/account/plan/checkout/return?session_id=../../v1/customers`),
    );
    expect(garbage.headers.get("location")).toBe(`${baseUrl}/account/usage?checkout=failed`);
    // Not paid yet: the page waits for the webhook.
    const early = await getCheckoutReturn(
      new NextRequest(`${baseUrl}/api/account/plan/checkout/return?session_id=${sessionId}`),
    );
    expect(early.headers.get("location")).toBe(`${baseUrl}/account/usage?checkout=pending`);
    expect((await plan()).plan.code).toBe("payg");
  });

  it("does not give another account's purchase to whoever opens its return link", async () => {
    await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    const returnUrl = fake.completeCheckout(sessionId);
    fake.takeDeliveries();

    await signIn();
    const response = await getCheckoutReturn(new NextRequest(returnUrl));
    expect(response.headers.get("location")).toBe(`${baseUrl}/account/usage?checkout=failed`);
    expect((await plan()).plan.code).toBe("payg");
  });

  it("refuses a second purchase, an unknown plan and an unverified email", async () => {
    const accountId = await signIn();
    await buy("private-5", accountId);
    expect((await startCheckout("private-9")).body.error).toBe("already_subscribed");
    expect((await startCheckout("business-49")).body.error).toBe("already_subscribed");
    expect((await startCheckout("business-50")).status).toBe(404);
    expect((await startCheckout("payg")).status).toBe(404);

    await signIn({ verified: false });
    expect((await startCheckout("private-5")).body.error).toBe("email_not_verified");
  });

  it("reuses the Stripe customer of an earlier subscription", async () => {
    const accountId = await signIn();
    const first = await buy("private-5", accountId);
    const customer = fake.subscriptions.get(first)!.customer;
    fake.cancelNow(first);
    await deliver();
    const { sessionId } = await startCheckout("private-9");
    expect(fake.checkouts.get(sessionId)?.["customer"]).toBe(customer);
    expect(fake.checkouts.get(sessionId)?.["customer_email"]).toBeNull();
  });

  it("puts each checkout's customer on a test clock when asked to", async () => {
    process.env.STRIPE_TEST_CLOCKS = "1";
    await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId, status } = await startCheckout("private-5");
    expect(status).toBe(200);
    expect(fake.testClocks.size).toBe(1);
    const customer = fake.customers.get(String(fake.checkouts.get(sessionId)?.["customer"]));
    expect(customer?.["test_clock"]).toBe([...fake.testClocks.keys()][0]);
  });

  it("says so when nothing can be bought", async () => {
    await signIn();
    delete process.env.STRIPE_SECRET_KEY;
    const view = await plan();
    expect(view.billing).toEqual({
      checkout: false,
      manage: false,
      mode: null,
      prices_exclude_tax: false,
      subscription: null,
      tax_label: null,
    });
    expect(view.catalog.groups.map((group) => group.available)).toEqual([true, false, false]);
    expect((await startCheckout("private-5")).status).toBe(503);
    const response = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-5" }));
    expect(response.status).toBe(404);
  });

  it("keeps test mode to the operators on a production build", async () => {
    await signIn();
    await syncPlans(db, config(), portalUrls);
    vi.stubEnv("NODE_ENV", "production");
    expect((await plan()).billing.checkout).toBe(false);
    expect((await plan()).catalog.groups[1]?.available).toBe(false);
    expect((await startCheckout("private-5")).status).toBe(503);

    await signIn({ superadmin: true });
    expect((await plan()).billing.checkout).toBe(true);
    expect((await startCheckout("private-5")).status).toBe(200);
  });

  it("keeps live mode to the operators until checkout is opened", () => {
    expect(checkoutOpenTo("live", false, {})).toBe(false);
    expect(checkoutOpenTo("live", true, {})).toBe(true);
    expect(checkoutOpenTo("live", false, { STRIPE_CHECKOUT_OPEN: "1" })).toBe(true);
    // A live key is real money on any build.
    expect(checkoutOpenTo("live", false, { NODE_ENV: "development" })).toBe(false);
    // Each mode has its own switch.
    expect(checkoutOpenTo("live", false, { STRIPE_TEST_OPEN: "1" })).toBe(false);
    expect(checkoutOpenTo("test", false, { NODE_ENV: "production", STRIPE_CHECKOUT_OPEN: "1" })).toBe(false);
    expect(checkoutOpenTo("test", false, { NODE_ENV: "production", STRIPE_TEST_OPEN: "1" })).toBe(true);
  });

  it("grants a test purchase and keeps it out of the books", async () => {
    delete process.env.STRIPE_TEST_LEDGER;
    useFake({ feeFixed: 30, feePercent: 2.9, taxPercent: 21 });
    const accountId = await signIn();
    await buy("private-5", accountId);
    expect((await plan()).plan.code).toBe("private-5");
    const rows = await db.select().from(providerPayments);
    expect(rows.map((row) => [row.kind, row.posted]).sort()).toEqual([
      ["fee", false],
      ["payment", false],
    ]);
    expect(await books(accountId)).toEqual({ ...nothingElse, deferred: 0n, psp: 0n });
  });

  it("refuses a live key in test mode, a test key in live mode, and a publishable key", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_key";
    expect(stripeSetup().config).toBeNull();
    expect(stripeSetup().problem).toMatch(/live key/);
    process.env.STRIPE_MODE = "live";
    expect(stripeSetup().config?.mode).toBe("live");
    // The stand-in is for test mode only.
    expect(stripeSetup().config?.apiBase).toBeNull();
    process.env.STRIPE_SECRET_KEY = secretKey;
    expect(stripeSetup().config).toBeNull();
    process.env.STRIPE_SECRET_KEY = "pk_live_key";
    expect(stripeSetup().problem).toMatch(/publishable/);
  });
});

describe("where the price list is", () => {
  it("sends a visitor to the product site and an account to its own plans", async () => {
    const visitor = await getPricing();
    expect(visitor.status).toBe(307);
    expect(visitor.headers.get("location")).toBe("https://frameos.net/pricing/");

    await signIn();
    const account = await getPricing();
    expect(account.headers.get("location")).toBe(`${baseUrl}/account/usage`);
  });
});

describe("changing and ending a plan", () => {
  it("cancels at the end of the paid month, and takes it back", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);

    const cancel = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "payg" }));
    expect(cancel.status).toBe(200);
    expect(fake.subscriptions.get(subscriptionId)?.cancel_at_period_end).toBe(true);
    let view = await plan();
    expect(view.plan.code).toBe("private-5");
    expect(view.billing.subscription?.status).toBe("scheduled_cancel");
    expect(view.billing.subscription?.cancel_at).toBe(
      fake.subscriptions.get(subscriptionId)?.periodEnd.toISOString(),
    );
    expect(view.billing.subscription?.renews_at).toBeNull();
    expect((await readAccountPlan(db, accountId)).status).toBe("canceling");

    const keep = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-5" }));
    expect(keep.status).toBe(200);
    expect(fake.subscriptions.get(subscriptionId)?.cancel_at_period_end).toBe(false);
    view = await plan();
    expect(view.billing.subscription?.cancel_at).toBeNull();
    expect((await readAccountPlan(db, accountId)).status).toBe("active");

    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "payg" }));
    fake.takeDeliveries();
    fake.renew(subscriptionId);
    expect(await deliver()).toEqual([200]);
    view = await plan();
    expect(view.plan.code).toBe("payg");
    expect(view.billing.subscription).toBeNull();
    // Paid, kept, and nothing owed either way.
    expect((await books(accountId)).receivable).toBe(0n);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.accountId, accountId));
    expect(audit.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["account.plan_checkout_started", "account.plan_canceled", "account.plan_changed"]),
    );
  });

  it("follows a cancellation made in Stripe's portal", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    fake.subscriptions.get(subscriptionId)!.cancel_at_period_end = true;
    // The portal's notice, as Stripe would send it.
    fake.changePriceInDashboard(subscriptionId, fake.subscriptions.get(subscriptionId)!.item.price);
    await deliver();
    expect((await readAccountPlan(db, accountId)).status).toBe("canceling");
  });

  it("starts a larger plan at once and books the prorated charge with it", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);

    // Halfway through the month, as Stripe sees it.
    const subscription = fake.subscriptions.get(subscriptionId)!;
    clock = new Date((subscription.periodStart.getTime() + subscription.periodEnd.getTime()) / 2);
    const response = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-9" }));
    expect(response.status).toBe(200);
    expect((await plan()).plan.code).toBe("private-9");

    await deliver();
    const view = await plan();
    expect(view.plan.code).toBe("private-9");
    expect(view.next_plan_code).toBeNull();
    // $5 for the month, then half of the $4 difference, each with 21% VAT.
    expect(await books(accountId)).toEqual({
      ...nothingElse,
      deferred: dollars(7),
      psp: dollars(7 * 1.21),
      salesTax: dollars(7 * 0.21),
    });
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("moves from Private to Business, from one product to the other", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    const subscriptionId = await buy("private-29", accountId);

    const subscription = fake.subscriptions.get(subscriptionId)!;
    clock = new Date((subscription.periodStart.getTime() + subscription.periodEnd.getTime()) / 2);
    const response = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "business-49" }));
    expect(response.status).toBe(200);
    await deliver();
    const view = await plan();
    expect(view.plan.code).toBe("business-49");
    expect(view.next_plan_code).toBeNull();
    // Stripe bills the Business product's price now.
    const price = fake.prices.get(fake.subscriptions.get(subscriptionId)!.item.price)!;
    expect(price.unit_amount).toBe(4900);
    const product = fake.products.get(price.product)!;
    expect((product["metadata"] as Record<string, string>)["frameos_cloud_group"]).toBe("business");
    // $29 for the month, then half of the $20 difference, each with 21% VAT.
    expect(await books(accountId)).toEqual({
      ...nothingElse,
      deferred: dollars(39),
      psp: dollars(39 * 1.21),
      salesTax: dollars(39 * 0.21),
    });
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("holds an upgrade the bank wants confirmed until it is paid", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    fake.nextChargeNeedsAction = true;
    const response = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-9" }));
    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: string; url: string };
    expect(body.error).toBe("payment_action_required");
    expect(body.url).toBe(`https://invoice.stripe.fake/${latestInvoiceOf(subscriptionId)}`);
    await deliver();
    expect((await plan()).plan.code).toBe("private-5");
    // A second try while the first waits is refused with the same page.
    const again = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-29" }));
    expect(((await again.json()) as { url: string }).url).toBe(body.url);

    // Confirmed on Stripe's invoice page.
    fake.payInvoice(latestInvoiceOf(subscriptionId));
    await deliver();
    expect((await plan()).plan.code).toBe("private-9");
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("follows a larger plan set in Stripe's dashboard before its charge is reported", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    const nine = (await db.select().from(providerProducts)).find((row) => row.planCode === "private-9")!;
    fake.changePriceInDashboard(subscriptionId, nine.productId);
    await deliver();
    expect((await plan()).plan.code).toBe("private-9");
    // Nothing collected for it yet, nothing invented.
    expect(await books(accountId)).toEqual({ ...nothingElse, deferred: dollars(5), psp: dollars(5) });
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("starts a smaller plan at the next renewal", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-9", accountId);

    const response = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-2" }));
    expect(response.status).toBe(200);
    await deliver();
    let view = await plan();
    expect(view.plan.code).toBe("private-9");
    expect(view.next_plan_code).toBe("private-2");
    expect((await books(accountId)).psp).toBe(dollars(9));

    clock = fake.subscriptions.get(subscriptionId)!.periodEnd;
    fake.renew(subscriptionId);
    expect(await deliver()).toEqual([200, 200]);
    view = await plan();
    expect(view.plan.code).toBe("private-2");
    expect(view.next_plan_code).toBeNull();
    expect(await books(accountId)).toEqual({ ...nothingElse, deferred: dollars(11), psp: dollars(11) });
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(2);
  });

  it("charges nothing for taking a downgrade back", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-9", accountId);
    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-5" }));
    await deliver();
    expect((await plan()).next_plan_code).toBe("private-5");

    // Back to the plan already paid for this month, also through a cancel.
    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "payg" }));
    const keep = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-9" }));
    expect(keep.status).toBe(200);
    await deliver();
    const view = await plan();
    expect(view.plan.code).toBe("private-9");
    expect(view.next_plan_code).toBeNull();
    expect(view.billing.subscription?.cancel_at).toBeNull();
    expect(fake.prices.get(fake.subscriptions.get(subscriptionId)!.item.price)?.unit_amount).toBe(900);
    expect(await db.select().from(providerPayments).where(eq(providerPayments.kind, "payment"))).toHaveLength(1);
    expect((await books(accountId)).psp).toBe(dollars(9));
  });

  it("prorates a larger plan from what was paid, not from a pending downgrade", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-9", accountId);
    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-2" }));
    await deliver();

    const subscription = fake.subscriptions.get(subscriptionId)!;
    clock = new Date((subscription.periodStart.getTime() + subscription.periodEnd.getTime()) / 2);
    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-29" }));
    await deliver();
    expect((await plan()).plan.code).toBe("private-29");
    // $9, then half of the $20 from $9 to $29. Not half of $27 from $2.
    expect((await books(accountId)).psp).toBe(dollars(19));
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("keeps the plan while a failed renewal is retried, and ends it when Stripe gives up", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);

    clock = fake.subscriptions.get(subscriptionId)!.periodEnd;
    fake.renew(subscriptionId, { fail: true });
    await deliver();
    let view = await plan();
    expect(view.plan.code).toBe("private-5");
    expect(view.billing.subscription?.past_due).toBe(true);
    // No changing plan on a card that is failing.
    const change = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-9" }));
    expect(((await change.json()) as { error: string }).error).toBe("payment_failed");
    // Nothing was collected for the new month, so nothing was booked.
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(1);

    fake.cancelNow(subscriptionId);
    await deliver();
    view = await plan();
    expect(view.plan.code).toBe("payg");
    expect((await books(accountId)).receivable).toBe(0n);
  });

  it("opens the month a late payment of a failed renewal paid for", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    clock = fake.subscriptions.get(subscriptionId)!.periodEnd;
    fake.renew(subscriptionId, { fail: true });
    await deliver();
    // A new card in the portal, and Stripe retries.
    fake.payInvoice(latestInvoiceOf(subscriptionId));
    await deliver();
    const view = await plan();
    expect(view.plan.code).toBe("private-5");
    expect(view.billing.subscription?.past_due).toBe(false);
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(2);
    expect((await books(accountId)).psp).toBe(dollars(10));
  });

  it("hands a refund back out of the books, VAT included", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    const refundId = fake.refund(latestInvoiceOf(subscriptionId), { pending: true });
    // Pending: no money has moved yet.
    expect(await deliver()).toEqual([200]);
    expect((await books(accountId)).psp).toBe(dollars(6.05));
    fake.settleRefund(refundId);
    expect(await deliver()).toEqual([200]);
    expect(await books(accountId)).toEqual({ ...nothingElse, deferred: 0n, psp: 0n });
    const refund = (await db.select().from(providerPayments)).find((row) => row.kind === "refund");
    expect(refund?.amountMicros).toBe(dollars(5));
    expect(refund?.taxMicros).toBe(dollars(1.05));
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("splits a partial refund between the price and the VAT", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    const subscriptionId = await buy("private-9", accountId);
    // Half of the $10.89 charged.
    fake.refund(latestInvoiceOf(subscriptionId), { amount: 545 });
    await deliver();
    const refund = (await db.select().from(providerPayments)).find((row) => row.kind === "refund");
    expect(refund?.amountMicros).toBe(4_504_132n);
    expect(refund?.taxMicros).toBe(5_450_000n - 4_504_132n);
    expect((await books(accountId)).salesTax).toBe(dollars(1.89) - (5_450_000n - 4_504_132n));
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("books a lost dispute as money handed back, and its fee as a cost", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    const disputeId = fake.dispute(latestInvoiceOf(subscriptionId));
    const opened = await deliver();
    expect(opened).toEqual([200]);
    const [event] = await db
      .select()
      .from(providerEvents)
      .where(eq(providerEvents.eventType, "charge.dispute.created"));
    expect(event?.processedAt).not.toBeNull();

    fake.closeDispute(disputeId, "lost");
    expect(await deliver()).toEqual([200]);
    expect(await books(accountId)).toEqual({
      ...nothingElse,
      deferred: 0n,
      fees: dollars(15),
      psp: -dollars(15),
    });
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("books a dispute fee charged in euros at the rate its charge settled at", async () => {
    // As Stripe did in test mode on 2026-11-07: a €20 fee, no rate on it.
    useFake({ exchangeRate: 0.897334, feeFixed: 25, feePercent: 1.5, settlementCurrency: "eur" });
    const accountId = await signIn();
    const subscriptionId = await buy("private-2", accountId);
    const disputeId = fake.dispute(latestInvoiceOf(subscriptionId));
    fake.closeDispute(disputeId, "lost");
    await deliver();
    const [fee] = await db
      .select()
      .from(providerPayments)
      .where(eq(providerPayments.transactionId, `${disputeId}:fee`));
    // €20.00 / 0.897334 = $22.288245.
    expect(fee?.amountMicros).toBe(22_288_245n);
    expect(fee?.details).not.toHaveProperty("unconverted");
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("keeps the money of a won dispute and books its fee", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    const disputeId = fake.dispute(latestInvoiceOf(subscriptionId));
    fake.closeDispute(disputeId, "won");
    await deliver();
    expect(await books(accountId)).toEqual({
      ...nothingElse,
      deferred: dollars(5),
      fees: dollars(15),
      psp: dollars(5) - dollars(15),
    });
  });

  it("does not let an operator change a plan Stripe bills", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    await signIn({ superadmin: true });
    for (const target of ["private-9", "payg"]) {
      const response = await putCustomerPlan(
        jsonRequest("PUT", `/api/admin/billing/customers/${accountId}/plan`, {
          plan: target,
          reason: "asked by email",
        }),
        { params: Promise.resolve({ accountId }) },
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe("billed_by_provider");
    }
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("private-5");
    expect(fake.subscriptions.get(subscriptionId)?.status).toBe("active");
  });

  it("opens Stripe's billing page for a customer, and for nobody else", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    const response = await postPortal(jsonRequest("POST", "/api/account/plan/portal"));
    const body = (await response.json()) as { url: string };
    expect(body.url).toBe(`https://billing.stripe.fake/p/session/${fake.subscriptions.get(subscriptionId)!.customer}`);

    await signIn();
    expect((await postPortal(jsonRequest("POST", "/api/account/plan/portal"))).status).toBe(404);
  });
});

describe("when a notice goes wrong", () => {
  it("keeps a notice it could not apply, says why, and asks for it again", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    // The account is gone by the time the payment is reported.
    await db.delete(accounts).where(eq(accounts.id, accountId));
    fake.completeCheckout(sessionId);
    expect(await deliver({ only: ["invoice.paid"] })).toEqual([500]);
    const [event] = await db.select().from(providerEvents);
    expect(event?.processedAt).toBeNull();
    expect(event?.error).toMatch(/names no account of ours/);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it("acknowledges a notice for something this service did not sell", async () => {
    await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    // Sold from Stripe's dashboard: no account in its metadata.
    fake.checkouts.get(sessionId)!["subscription_metadata"] = {};
    fake.completeCheckout(sessionId);
    expect(await deliver({ only: ["invoice.paid"] })).toEqual([200]);
    const [event] = await db.select().from(providerEvents);
    expect(event?.processedAt).not.toBeNull();
    expect(event?.error).toMatch(/not started from this service/);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it("ignores an event from the other mode", async () => {
    await signIn();
    const body = JSON.stringify({
      data: { object: { id: "sub_x", object: "subscription" } },
      id: "evt_live",
      livemode: true,
      object: "event",
      type: "customer.subscription.updated",
    });
    const response = await send(body, signWebhookForTests(body, webhookSecret));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true, reason: "other_mode" });
    expect(await db.select().from(providerEvents)).toHaveLength(0);
  });

  it("asks again for a refund whose payment is not recorded yet", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    fake.completeCheckout(sessionId);
    const purchase = fake.takeDeliveries();
    const subscriptionId = [...fake.subscriptions.keys()][0]!;
    fake.refund(latestInvoiceOf(subscriptionId));
    const [refund] = fake.takeDeliveries();
    expect((await send(refund!.body, refund!.signature)).status).toBe(500);
    const [refundEvent] = await db
      .select()
      .from(providerEvents)
      .where(eq(providerEvents.eventType, "refund.created"));
    expect(refundEvent?.error).toMatch(/not recorded yet/);
    for (const delivery of purchase) {
      await send(delivery.body, delivery.signature);
    }
    // Stripe's retry of the refund notice now applies.
    expect((await send(refund!.body, refund!.signature)).status).toBe(200);
    expect((await books(accountId)).psp).toBe(0n);
  });

  it("lets a test purchase lapse once the deployment is live", async () => {
    delete process.env.STRIPE_TEST_LEDGER;
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    const periodEnd = fake.subscriptions.get(subscriptionId)!.periodEnd;

    const live = { ...config(), mode: "live" as const, secretKey: "sk_live_x" };
    // Still inside the month it was granted for: left alone.
    let result = await reconcileSubscriptions(db, live);
    expect(result.lapsed).toBe(0);
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("private-5");

    const before = fake.calls.length;
    result = await reconcileSubscriptions(db, live, { now: new Date(periodEnd.getTime() + 60 * 60 * 1000) });
    expect(result).toEqual({ checked: 0, completed: 0, failures: [], lapsed: 1 });
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("payg");
    // Nothing was asked of Stripe: a live key cannot see a test subscription.
    expect(fake.calls.slice(before).filter((call) => call.startsWith("GET /v1/subscriptions"))).toHaveLength(0);
  });

  it("does not let a late notice for a replaced subscription end the new one", async () => {
    const accountId = await signIn();
    const first = await buy("private-5", accountId);
    fake.cancelNow(first);
    const [late] = fake.takeDeliveries();
    // Cancelled as far as we know (the notice is still in the post).
    await db
      .update(providerSubscriptions)
      .set({ status: "canceled" })
      .where(eq(providerSubscriptions.subscriptionId, first));

    const { sessionId } = await startCheckout("private-9");
    fake.completeCheckout(sessionId);
    await deliver();
    expect((await plan()).plan.code).toBe("private-9");

    const response = await send(late!.body, late!.signature);
    expect(response.status).toBe(200);
    expect((await plan()).plan.code).toBe("private-9");
  });

  it("finds a renewal whose notice never arrived, and a lapse", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    clock = fake.subscriptions.get(subscriptionId)!.periodEnd;
    fake.renew(subscriptionId);
    fake.takeDeliveries();
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(1);

    // The night after the period we know of ran out.
    const night = new Date(clock.getTime() + 60 * 60 * 1000);
    const result = await reconcileSubscriptions(db, config(), { now: night });
    expect(result.checked).toBe(1);
    expect(result.failures).toEqual([]);
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(2);
    expect((await books(accountId)).psp).toBe(dollars(10));
    expect((await plan()).plan.code).toBe("private-5");

    // And a lapsed one loses its plan.
    fake.cancelNow(subscriptionId);
    fake.takeDeliveries();
    const later = new Date(fake.subscriptions.get(subscriptionId)!.periodEnd.getTime() + 60 * 60 * 1000);
    await reconcileSubscriptions(db, config(), { now: later });
    expect((await plan()).plan.code).toBe("payg");
  });

  it("books later a fee Stripe had not settled when the payment arrived", async () => {
    useFake({ feeFixed: 30, feePercent: 2.9 });
    const accountId = await signIn();
    await buy("private-5", accountId);
    // As if the charge had not settled when the payment was applied.
    await db.delete(providerPayments).where(eq(providerPayments.kind, "fee"));
    await db.update(providerPayments).set({ paymentRef: null });
    const result = await reconcileSubscriptions(db, config());
    expect(result.completed).toBe(1);
    const [fee] = await db.select().from(providerPayments).where(eq(providerPayments.kind, "fee"));
    // 2.9% of $5 and 30 cents.
    expect(fee?.amountMicros).toBe(dollars(0.45));
    expect(fee?.paymentRef).toMatch(/^ch_/);
    // Booked once in the ledger, however often the row was made.
    expect((await books(accountId)).fees).toBe(dollars(0.45));
  });

  it("refuses a payment in a currency the books do not keep", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    fake.completeCheckout(sessionId);
    const deliveries = fake.takeDeliveries();
    const paid = deliveries.find((delivery) => delivery.eventType === "invoice.paid")!;
    // As Stripe's adaptive pricing would have charged it.
    const subscriptionId = [...fake.subscriptions.keys()][0]!;
    fake.invoices.get(latestInvoiceOf(subscriptionId))!.currency = "eur";
    const response = await send(paid.body, paid.signature);
    expect(response.status).toBe(500);
    const [event] = await db.select().from(providerEvents);
    expect(event?.error).toMatch(/paid in EUR/);
    expect((await books(accountId)).psp).toBe(0n);
  });
});

interface ListedInvoice {
  amount_due_micros: string;
  currency: string;
  number: string | null;
  pdf_url: string | null;
  refunded_micros: string;
  status: string;
  tax_micros: string;
  total_micros: string;
  url: string | null;
}

async function invoices() {
  const response = await getInvoices(new NextRequest(new URL("/api/account/plan/invoices", baseUrl)));
  return { status: response.status, ...((await response.json()) as { invoices: ListedInvoice[] }) };
}

describe("the account's invoices", () => {
  it("lists what was paid with its VAT, and what was refunded on it", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    expect(await invoices()).toEqual({ invoices: [], status: 200 });
    const subscriptionId = await buy("private-9", accountId);
    const [paid] = (await invoices()).invoices;
    expect(paid).toMatchObject({
      amount_due_micros: "0",
      currency: "USD",
      refunded_micros: "0",
      status: "paid",
      tax_micros: "1890000",
      total_micros: "10890000",
    });
    expect(paid?.number).toMatch(/^FAKE-/);
    expect(paid?.url).toBe(`https://invoice.stripe.fake/${latestInvoiceOf(subscriptionId)}`);
    expect(paid?.pdf_url).toMatch(/\/pdf$/);

    fake.refund(latestInvoiceOf(subscriptionId), { amount: 545 });
    await deliver();
    expect((await invoices()).invoices[0]).toMatchObject({ refunded_micros: "5450000", status: "partly_refunded" });
    fake.refund(latestInvoiceOf(subscriptionId), { amount: 544 });
    await deliver();
    expect((await invoices()).invoices[0]).toMatchObject({ refunded_micros: "10890000", status: "refunded" });
  });

  it("shows an invoice waiting for its payment as due, newest first", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    await buy("private-5", accountId);
    fake.nextChargeNeedsAction = true;
    expect((await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-9" }))).status).toBe(402);
    await deliver();
    const listed = (await invoices()).invoices;
    expect(listed.map((invoice) => invoice.status)).toEqual(["due", "paid"]);
    expect(BigInt(listed[0]?.amount_due_micros ?? "0")).toBeGreaterThan(0n);
  });

  it("is empty without Stripe, and another account sees none of them", async () => {
    const buyer = await signIn();
    await buy("private-5", buyer);
    await signIn();
    expect((await invoices()).invoices).toEqual([]);
    delete process.env.STRIPE_SECRET_KEY;
    expect(await invoices()).toEqual({ invoices: [], status: 200 });
  });
});

describe("the word after a price", () => {
  async function taxLabel(country?: string) {
    const response = await getPlan(
      new NextRequest(new URL("/api/account/plan", baseUrl), {
        headers: country ? { "cf-ipcountry": country } : {},
      }),
    );
    return ((await response.json()) as { billing: { tax_label: string | null } }).billing.tax_label;
  }

  it("is VAT for a visitor in Europe and tax elsewhere, by Cloudflare's country", async () => {
    await signIn();
    expect(await taxLabel("BE")).toBe("VAT");
    expect(await taxLabel("de")).toBe("VAT");
    expect(await taxLabel("GB")).toBe("VAT");
    expect(await taxLabel("US")).toBe("tax");
    // Cloudflare's "unknown" and "Tor".
    expect(await taxLabel("XX")).toBe("tax");
    expect(await taxLabel("T1")).toBe("tax");
    expect(await taxLabel()).toBe("tax");
  });

  it("is nothing when prices include the tax", async () => {
    await signIn();
    vi.stubEnv("STRIPE_TAX_BEHAVIOR", "inclusive");
    expect(await taxLabel("BE")).toBeNull();
  });
});

describe("telling the reports channel", () => {
  // Every plan event once, however many notices, returns and reconciles
  // apply the change behind it.
  function told() {
    return captured
      .filter((entry) => entry.event.startsWith("cloud plan "))
      .map((entry) => entry.event);
  }

  function last(event: string) {
    return captured.filter((entry) => entry.event === event).at(-1);
  }

  it("says once that a plan was bought, by the return from checkout and three notices", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    const returnUrl = fake.completeCheckout(sessionId);
    await getCheckoutReturn(new NextRequest(returnUrl));
    expect(await deliver()).toEqual([200, 200, 200]);
    await reconcileSubscriptions(db, config(), { now: new Date(clock.getTime() + 40 * 24 * 60 * 60 * 1000) });

    expect(told()).toEqual([planEvents.subscribed]);
    const bought = last(planEvents.subscribed)!;
    expect(bought.distinctId).toBe(accountId);
    expect(bought.properties).toMatchObject({
      amount: 5,
      mode: "test",
      plan_code: "private-5",
      summary: "[test] 🎉 New subscription: Private $5/month, $5 paid",
    });
    expect(String(bought.properties["admin_url"])).toContain(`/admin/billing/customers?account=${accountId}`);
    // Nobody's name or email goes to PostHog with it.
    expect(JSON.stringify(captured)).not.toContain("@example.com");
  });

  it("says it once when the return and the notices race each other", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), portalUrls);
    const { sessionId } = await startCheckout("private-5");
    const returnUrl = fake.completeCheckout(sessionId);
    const deliveries = fake.takeDeliveries();
    await Promise.all([
      getCheckoutReturn(new NextRequest(returnUrl)),
      ...deliveries.map((delivery) => send(delivery.body, delivery.signature)),
    ]);
    const [row] = await db.select().from(providerSubscriptions).where(eq(providerSubscriptions.accountId, accountId));
    // A cancellation in Stripe's portal, read back by four requests at once.
    fake.subscriptions.get(row!.subscriptionId)!.cancel_at_period_end = true;
    const subscription = await retrieveSubscription(config(), row!.subscriptionId);
    await Promise.all([1, 2, 3, 4].map(() => applySubscription(db, config(), subscription)));
    expect(told()).toEqual([planEvents.subscribed, planEvents.cancellationScheduled]);
  });

  it("says a cancellation, its taking back, and the end it ran to", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "payg" }));
    await deliver();
    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-5" }));
    await deliver();
    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "payg" }));
    await deliver();
    clock = fake.subscriptions.get(subscriptionId)!.periodEnd;
    fake.renew(subscriptionId);
    await deliver();

    expect(told()).toEqual([
      planEvents.subscribed,
      planEvents.cancellationScheduled,
      planEvents.cancellationWithdrawn,
      planEvents.cancellationScheduled,
      planEvents.ended,
    ]);
    expect(last(planEvents.cancellationScheduled)?.properties["at"]).toBe(
      fake.subscriptions.get(subscriptionId)!.periodEnd.toISOString(),
    );
    expect(last(planEvents.ended)?.properties).toMatchObject({ plan_code: "private-5", reason: "scheduled" });
  });

  it("says a downgrade when it is asked for and when the renewal makes it, and an upgrade", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    const subscriptionId = await buy("private-9", accountId);
    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-2" }));
    await deliver();
    clock = fake.subscriptions.get(subscriptionId)!.periodEnd;
    fake.renew(subscriptionId);
    await deliver();
    const subscription = fake.subscriptions.get(subscriptionId)!;
    clock = new Date((subscription.periodStart.getTime() + subscription.periodEnd.getTime()) / 2);
    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-29" }));
    await deliver();
    clock = fake.subscriptions.get(subscriptionId)!.periodEnd;
    fake.renew(subscriptionId);
    await deliver();

    expect(told()).toEqual([
      planEvents.subscribed,
      planEvents.downgradeScheduled,
      planEvents.changed,
      planEvents.changed,
      planEvents.renewed,
    ]);
    const [down, up] = captured.filter((entry) => entry.event === planEvents.changed);
    expect(down?.properties).toMatchObject({ from_plan_code: "private-9", plan_code: "private-2", tax: 0.42 });
    expect(String(down?.properties["summary"])).toContain("⬇️ Downgrade");
    expect(up?.properties).toMatchObject({ from_plan_code: "private-2", plan_code: "private-29" });
    expect(String(up?.properties["summary"])).toContain("⬆️ Upgrade");
  });

  it("says a larger plan set in Stripe's dashboard before its charge, once", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    const nine = (await db.select().from(providerProducts)).find((row) => row.planCode === "private-9")!;
    fake.changePriceInDashboard(subscriptionId, nine.productId);
    await deliver();
    await reconcileSubscriptions(db, config(), { now: new Date(clock.getTime() + 8 * 24 * 60 * 60 * 1000) });
    expect(told()).toEqual([planEvents.subscribed, planEvents.changed]);
    expect(String(last(planEvents.changed)?.properties["summary"])).toContain("charge to follow");
  });

  it("says a renewal failed, and that the plan ended when Stripe gave up", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    clock = fake.subscriptions.get(subscriptionId)!.periodEnd;
    fake.renew(subscriptionId, { fail: true });
    await deliver();
    fake.cancelNow(subscriptionId);
    await deliver();
    expect(told()).toEqual([planEvents.subscribed, planEvents.paymentFailed, planEvents.ended]);
    expect(last(planEvents.ended)?.properties["reason"]).toBe("payment_failed");
  });

  it("says a failed renewal paid late as a renewal", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    clock = fake.subscriptions.get(subscriptionId)!.periodEnd;
    fake.renew(subscriptionId, { fail: true });
    await deliver();
    fake.payInvoice(latestInvoiceOf(subscriptionId));
    await deliver();
    expect(told()).toEqual([planEvents.subscribed, planEvents.paymentFailed, planEvents.renewed]);
  });

  it("says a refund once it settles, and a dispute when it opens and closes", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    const refundId = fake.refund(latestInvoiceOf(subscriptionId), { amount: 300, pending: true });
    await deliver();
    expect(told()).toEqual([planEvents.subscribed]);
    fake.settleRefund(refundId);
    const settled = fake.takeDeliveries();
    for (const delivery of [...settled, ...settled]) {
      await send(delivery.body, delivery.signature);
    }
    expect(last(planEvents.refunded)?.properties).toMatchObject({ amount: 3, plan_code: "private-5", refund_id: refundId });

    const disputeId = fake.dispute(latestInvoiceOf(subscriptionId));
    await deliver();
    fake.closeDispute(disputeId, "won");
    await deliver();
    expect(told()).toEqual([
      planEvents.subscribed,
      planEvents.refunded,
      planEvents.disputeOpened,
      planEvents.disputeClosed,
    ]);
    expect(last(planEvents.disputeOpened)?.distinctId).toBe(accountId);
    expect(last(planEvents.disputeClosed)?.properties).toMatchObject({ dispute_id: disputeId, status: "won" });
  });

  it("says a plan ended with the account deleted", async () => {
    const accountId = await signIn();
    await buy("private-5", accountId);
    await cancelForErasure(db, stripeSetup(), accountId);
    await deliver();
    expect(told()).toEqual([planEvents.subscribed, planEvents.ended]);
    expect(last(planEvents.ended)?.properties["reason"]).toBe("account_deleted");
  });
});

describe("deleting an account with a paid plan", () => {
  it("ends the subscription at Stripe first", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    expect(await cancelForErasure(db, stripeSetup(), accountId)).toBe(1);
    expect(fake.subscriptions.get(subscriptionId)?.status).toBe("canceled");
    expect(await cancelForErasure(db, stripeSetup(), accountId)).toBe(0);
  });

  it("does not delete the account when Stripe cannot be told", async () => {
    const accountId = await signIn();
    await buy("private-5", accountId);
    const admin = await signIn({ superadmin: true });
    expect(admin).not.toBe(accountId);
    fake.down = true;
    const response = await deleteAccountAsAdmin(
      jsonRequest("DELETE", `/api/admin/users/${accountId}`),
      { params: Promise.resolve({ accountId }) },
    );
    expect(response.status).toBe(502);
    expect(await db.select().from(accounts).where(eq(accounts.id, accountId))).toHaveLength(1);
  });
});
