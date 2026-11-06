// Paid plans through the payment provider (cloud/docs/billing.md): the
// routes a buyer touches, the webhook, the nightly reconcile and account
// deletion, against a stand-in for Creem's test API (../creem-fake.ts). The
// ledger package proves the accounting of a payment; this proves that what
// the provider says ends up as the right plan, once, in the right order.
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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteAccountAsAdmin } from "../../../app/api/admin/users/[accountId]/route";
import { PUT as putCustomerPlan } from "../../../app/api/admin/billing/customers/[accountId]/plan/route";
import { POST as postSync } from "../../../app/api/admin/billing/provider/route";
import { POST as postCheckout } from "../../../app/api/account/plan/checkout/route";
import { GET as getCheckoutReturn } from "../../../app/api/account/plan/checkout/return/route";
import { POST as postPortal } from "../../../app/api/account/plan/portal/route";
import { GET as getPlan, PUT as putPlan } from "../../../app/api/account/plan/route";
import { POST as postWebhook } from "../../../app/api/webhooks/creem/route";
import { GET as getPricing } from "../../../app/pricing/route";
import {
  cancelForErasure,
  reconcileSubscriptions,
  syncPlans,
} from "../../lib/billing-provider";
import { creemSetup } from "../../lib/creem";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";
import { CreemFake } from "../creem-fake";

const cookieJar = vi.hoisted(() => new Map<string, string>());

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
const apiKey = "creem_test_integration";
const webhookSecret = "whsec_integration";
const db = createDb();
let userCounter = 0;
let fake: CreemFake;
let clock: Date;

afterAll(async () => {
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
      ('revenue:subscriptions', 'revenue', 'credit', 'revenue')
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

function useFake(options: { prorationReported?: boolean; taxPercent?: number } = {}) {
  fake = new CreemFake({
    apiKey,
    baseUrl: "http://creem.fake",
    now: () => clock,
    webhookSecret,
    ...options,
  });
  // The routes reach Creem through the global fetch.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    fake.fetchWithLag(String(input), init ?? {}),
  );
}

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
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
  process.env.CREEM_API_KEY = apiKey;
  process.env.CREEM_WEBHOOK_SECRET = webhookSecret;
  process.env.CREEM_API_URL = "http://creem.fake";
  // Post test payments, so the books can be checked.
  process.env.CREEM_TEST_LEDGER = "1";
  delete process.env.CREEM_MODE;
  clock = new Date();
  useFake();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const key of ["CREEM_API_KEY", "CREEM_WEBHOOK_SECRET", "CREEM_API_URL", "CREEM_TEST_LEDGER", "CREEM_MODE", "CREEM_TEST_OPEN"]) {
    delete process.env[key];
  }
});

function config() {
  const setup = creemSetup();
  if (!setup.config) {
    throw new Error(setup.problem ?? "Creem is not configured");
  }
  return setup.config;
}

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

async function deliver(options: { only?: string[] } = {}) {
  const statuses: number[] = [];
  for (const delivery of fake.takeDeliveries()) {
    if (options.only && !options.only.includes(delivery.eventType)) {
      continue;
    }
    const response = await postWebhook(
      new NextRequest(new URL("/api/webhooks/creem", baseUrl), {
        body: delivery.body,
        headers: { "content-type": "application/json", "creem-signature": delivery.signature },
        method: "POST",
      }),
    );
    statuses.push(response.status);
  }
  return statuses;
}

async function startCheckout(plan: string) {
  const response = await postCheckout(jsonRequest("POST", "/api/account/plan/checkout", { plan }));
  const body = (await response.json()) as { checkout_url?: string; error?: string };
  return { body, checkoutId: body.checkout_url?.split("/").pop() ?? "", status: response.status };
}

// Sync the plans and buy one, webhooks delivered.
async function buy(plan: string, accountId: string) {
  await syncPlans(db, config(), fake.fetch);
  const { checkoutId } = await startCheckout(plan);
  fake.completeCheckout(checkoutId);
  await deliver();
  const [row] = await db
    .select()
    .from(providerSubscriptions)
    .where(eq(providerSubscriptions.accountId, accountId));
  if (!row) {
    throw new Error("The purchase left no provider subscription");
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
    psp: await accountBalanceMicros(db, systemAccountCodes.psp),
    receivable: await accountBalanceMicros(db, customerReceivableCode(accountId)),
  };
}

const dollars = (value: number) => BigInt(Math.round(value * 1_000_000));

describe("syncing the plans", () => {
  it("makes every self-serve stop buyable, once", async () => {
    await signIn({ superadmin: true });
    const first = await postSync(jsonRequest("POST", "/api/admin/billing/provider"));
    expect(first.status).toBe(200);
    const body = (await first.json()) as { plans: { code: string; created: boolean }[] };
    expect(body.plans.map((entry) => [entry.code, entry.created])).toEqual([
      ["private-2", true],
      ["private-5", true],
      ["private-9", true],
      ["private-29", true],
    ]);
    expect(fake.products.size).toBe(4);
    expect([...fake.products.values()].map((product) => product.priceCents).sort((a, b) => a - b)).toEqual([
      200, 500, 900, 2900,
    ]);

    const second = await postSync(jsonRequest("POST", "/api/admin/billing/provider"));
    const again = (await second.json()) as { plans: { created: boolean }[] };
    expect(again.plans.every((entry) => !entry.created)).toBe(true);
    expect(fake.products.size).toBe(4);
    expect(await db.select().from(providerProducts)).toHaveLength(4);

    // The plan row holds the stop's limits, and nothing that is only planned.
    const bought = await readAccountPlan(db, await signIn());
    expect(bought.plan.code).toBe("payg");
    const [row] = await db.execute<{ entitlements: Record<string, number> }>(
      sql`select entitlements from billing_plans where code = 'private-5'`,
    );
    expect(row?.entitlements.frames).toBe(60);
    // Virtual frames are built: a $5 plan grants five of them.
    expect(row?.entitlements.cloud_rendered_frames).toBe(5);
  });

  it("adopts products the store already has, and replaces one that is gone", async () => {
    await syncPlans(db, config(), fake.fetch);
    const first = await db.select().from(providerProducts);
    expect(first).toHaveLength(4);

    // Another deployment on the same store (a fresh database) sells the
    // same four products instead of making four more.
    await db.delete(providerProducts);
    const adopted = await syncPlans(db, config(), fake.fetch);
    expect(adopted.every((entry) => !entry.created)).toBe(true);
    expect(fake.products.size).toBe(4);
    expect((await db.select().from(providerProducts)).map((row) => row.productId).sort()).toEqual(
      first.map((row) => row.productId).sort(),
    );

    // One is archived in the dashboard: the next sync makes it again and
    // stops selling the old one.
    const gone = first.find((row) => row.planCode === "private-9")!;
    fake.archived.add(gone.productId);
    const repaired = await syncPlans(db, config(), fake.fetch);
    expect(repaired.filter((entry) => entry.created).map((entry) => entry.code)).toEqual(["private-9"]);
    const rows = await db.select().from(providerProducts);
    const active = rows.filter((row) => row.planCode === "private-9" && row.active);
    expect(active).toHaveLength(1);
    expect(active[0]?.productId).not.toBe(gone.productId);
    // A subscription still on the old product resolves to its plan.
    expect(rows.find((row) => row.productId === gone.productId)?.active).toBe(false);
  });

  it("is the operators' alone", async () => {
    await signIn();
    const response = await postSync(jsonRequest("POST", "/api/admin/billing/provider"));
    expect(response.status).toBe(403);
    expect(fake.products.size).toBe(0);
  });
});

describe("buying a plan", () => {
  it("puts the account on the plan when the provider says it was paid", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), fake.fetch);
    expect((await plan()).catalog.groups.map((group) => [group.key, group.available])).toEqual([
      ["free", true],
      ["private", true],
      ["business", false],
    ]);

    const checkout = await startCheckout("private-5");
    expect(checkout.status).toBe(200);
    expect(checkout.body.checkout_url).toBe(`http://creem.fake/checkout/${checkout.checkoutId}`);
    // The checkout names the account, and starting one changes nothing.
    expect(fake.checkouts.get(checkout.checkoutId)?.metadata).toEqual({
      account_id: accountId,
      plan_code: "private-5",
    });
    expect((await plan()).plan.code).toBe("payg");

    fake.completeCheckout(checkout.checkoutId);
    expect(await deliver()).toEqual([200, 200, 200]);

    const after = await plan();
    expect(after.plan.code).toBe("private-5");
    expect(after.billing.subscription?.status).toBe("active");
    expect(after.billing.subscription?.renews_at).toBeTruthy();
    expect(after.billing.manage).toBe(true);
    // Three notices about one payment: one period, one payment, nothing owed.
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(1);
    expect(await db.select().from(providerPayments)).toHaveLength(1);
    expect(await books(accountId)).toEqual({
      deferred: dollars(5),
      psp: dollars(5),
      receivable: 0n,
    });
    expect(await checkLedgerIntegrity(db)).toEqual([]);
    const events = await db.select().from(providerEvents);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.processedAt && event.accountId === accountId)).toBe(true);
    // What we keep of a notice has no name or email in it.
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain("@example.com");
  });

  it("books the price without the tax the provider added", async () => {
    useFake({ taxPercent: 21 });
    const accountId = await signIn();
    await buy("private-9", accountId);
    const [payment] = await db.select().from(providerPayments);
    expect(payment?.amountMicros).toBe(dollars(9));
    expect(payment?.taxMicros).toBe(dollars(1.89));
    expect((await books(accountId)).psp).toBe(dollars(9));
  });

  it("applies a retried notice once and refuses a forged one", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), fake.fetch);
    const { checkoutId } = await startCheckout("private-2");
    fake.completeCheckout(checkoutId);
    const deliveries = fake.takeDeliveries();
    const send = (body: string, signature: string) =>
      postWebhook(
        new NextRequest(new URL("/api/webhooks/creem", baseUrl), {
          body,
          headers: { "creem-signature": signature },
          method: "POST",
        }),
      );
    const paid = deliveries.find((delivery) => delivery.eventType === "subscription.paid")!;
    expect((await send(paid.body, "0".repeat(64))).status).toBe(401);
    expect((await send(paid.body.replace("private-2", "private-29"), paid.signature)).status).toBe(401);
    expect((await plan()).plan.code).toBe("payg");

    expect((await send(paid.body, paid.signature)).status).toBe(200);
    const retry = await send(paid.body, paid.signature);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ duplicate: true, ok: true });
    expect(await db.select().from(providerPayments)).toHaveLength(1);
    expect((await books(accountId)).psp).toBe(dollars(2));
  });

  it("grants the plan on the return from checkout, before any webhook", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), fake.fetch);
    const { checkoutId } = await startCheckout("private-5");
    const returnUrl = fake.completeCheckout(checkoutId);

    const response = await getCheckoutReturn(new NextRequest(returnUrl));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${baseUrl}/account/usage?checkout=active`);
    expect((await plan()).plan.code).toBe("private-5");

    // The webhooks arrive afterwards and change nothing.
    expect(await deliver()).toEqual([200, 200, 200]);
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(1);
    expect((await books(accountId)).psp).toBe(dollars(5));
  });

  it("does not believe a return link that checkout did not sign", async () => {
    await signIn();
    await syncPlans(db, config(), fake.fetch);
    const { checkoutId } = await startCheckout("private-5");
    const returnUrl = new URL(fake.completeCheckout(checkoutId));
    fake.takeDeliveries();
    returnUrl.searchParams.set("signature", "f".repeat(64));
    const response = await getCheckoutReturn(new NextRequest(returnUrl));
    expect(response.headers.get("location")).toBe(`${baseUrl}/account/usage?checkout=failed`);
    expect((await plan()).plan.code).toBe("payg");
  });

  it("does not give another account's purchase to whoever opens its return link", async () => {
    await signIn();
    await syncPlans(db, config(), fake.fetch);
    const { checkoutId } = await startCheckout("private-5");
    const returnUrl = fake.completeCheckout(checkoutId);
    fake.takeDeliveries();

    await signIn();
    const response = await getCheckoutReturn(new NextRequest(returnUrl));
    expect(response.headers.get("location")).toBe(`${baseUrl}/account/usage?checkout=failed`);
    expect((await plan()).plan.code).toBe("payg");
  });

  it("refuses a second purchase, an unknown plan, an unverified email and an API token", async () => {
    const accountId = await signIn();
    await buy("private-5", accountId);
    expect((await startCheckout("private-9")).body.error).toBe("already_subscribed");
    expect((await startCheckout("business-49")).status).toBe(404);
    expect((await startCheckout("payg")).status).toBe(404);

    await signIn({ verified: false });
    expect((await startCheckout("private-5")).body.error).toBe("email_not_verified");
  });

  it("says so when nothing can be bought", async () => {
    await signIn();
    delete process.env.CREEM_API_KEY;
    const view = await plan();
    expect(view.billing).toEqual({ checkout: false, manage: false, mode: null, subscription: null });
    expect(view.catalog.groups.map((group) => group.available)).toEqual([true, false, false]);
    expect((await startCheckout("private-5")).status).toBe(503);
    const response = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-5" }));
    expect(response.status).toBe(404);
  });

  it("keeps test mode to the operators on a production build", async () => {
    await signIn();
    await syncPlans(db, config(), fake.fetch);
    vi.stubEnv("NODE_ENV", "production");
    expect((await plan()).billing.checkout).toBe(false);
    expect((await plan()).catalog.groups[1]?.available).toBe(false);
    expect((await startCheckout("private-5")).status).toBe(503);

    await signIn({ superadmin: true });
    expect((await plan()).billing.checkout).toBe(true);
    expect((await startCheckout("private-5")).status).toBe(200);
  });

  it("grants a test purchase and keeps it out of the books", async () => {
    delete process.env.CREEM_TEST_LEDGER;
    const accountId = await signIn();
    await buy("private-5", accountId);
    expect((await plan()).plan.code).toBe("private-5");
    const [payment] = await db.select().from(providerPayments);
    expect(payment?.posted).toBe(false);
    expect(payment?.amountMicros).toBe(dollars(5));
    expect(await books(accountId)).toEqual({ deferred: 0n, psp: 0n, receivable: 0n });
  });

  it("refuses a live key in test mode, and the other way round", async () => {
    process.env.CREEM_API_KEY = "creem_live_key";
    expect(creemSetup().config).toBeNull();
    expect(creemSetup().problem).toMatch(/live key/);
    process.env.CREEM_MODE = "live";
    expect(creemSetup().config?.baseUrl).toBe("https://api.creem.io");
    process.env.CREEM_API_KEY = apiKey;
    expect(creemSetup().config).toBeNull();
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
    const view = (await (
      await getPlan(new NextRequest(new URL("/api/account/plan", baseUrl)))
    ).json()) as { links: { pricing: string; refunds: string } };
    expect(view.links).toEqual({
      pricing: "https://frameos.net/pricing/",
      refunds: `${baseUrl}/legal/refunds`,
    });
  });
});

describe("changing and ending a plan", () => {
  it("cancels at the end of the paid month, and takes it back", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);

    const cancel = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "payg" }));
    expect(cancel.status).toBe(200);
    expect(fake.subscriptions.get(subscriptionId)?.status).toBe("scheduled_cancel");
    let view = await plan();
    expect(view.plan.code).toBe("private-5");
    expect(view.billing.subscription?.cancel_at).toBe(
      fake.subscriptions.get(subscriptionId)?.periodEnd.toISOString(),
    );
    expect(view.billing.subscription?.renews_at).toBeNull();
    expect((await readAccountPlan(db, accountId)).status).toBe("canceling");

    const keep = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-5" }));
    expect(keep.status).toBe(200);
    expect(fake.subscriptions.get(subscriptionId)?.status).toBe("active");
    view = await plan();
    expect(view.billing.subscription?.cancel_at).toBeNull();
    expect((await readAccountPlan(db, accountId)).status).toBe("active");

    await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "payg" }));
    fake.takeDeliveries();
    fake.endPeriod(subscriptionId);
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

  for (const prorationReported of [true, false]) {
    it(`starts a larger plan at once (charge ${prorationReported ? "on the answer" : "reported later"})`, async () => {
      useFake({ prorationReported });
      const accountId = await signIn();
      const subscriptionId = await buy("private-5", accountId);

      // Halfway through the month, as the provider sees it.
      const subscription = fake.subscriptions.get(subscriptionId)!;
      clock = new Date((subscription.periodStart.getTime() + subscription.periodEnd.getTime()) / 2);
      const response = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-9" }));
      expect(response.status).toBe(200);
      expect((await plan()).plan.code).toBe("private-9");
      expect(fake.calls).toContain(`POST /v1/subscriptions/${subscriptionId}/upgrade`);

      await deliver();
      const view = await plan();
      expect(view.plan.code).toBe("private-9");
      expect(view.next_plan_code).toBeNull();
      // $5 for the month, then half of the $4 difference.
      expect(await books(accountId)).toEqual({
        deferred: dollars(7),
        psp: dollars(7),
        receivable: 0n,
      });
      expect(await checkLedgerIntegrity(db)).toEqual([]);
    });
  }

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

    fake.endPeriod(subscriptionId);
    expect(await deliver()).toEqual([200]);
    view = await plan();
    expect(view.plan.code).toBe("private-2");
    expect(view.next_plan_code).toBeNull();
    expect(await books(accountId)).toEqual({
      deferred: dollars(11),
      psp: dollars(11),
      receivable: 0n,
    });
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
    expect(fake.products.get(fake.subscriptions.get(subscriptionId)!.productId)?.priceCents).toBe(900);
    expect(await db.select().from(providerPayments)).toHaveLength(1);
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

  it("keeps the plan while a failed payment is retried, and ends it when the provider gives up", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);

    fake.failRenewal(subscriptionId);
    await deliver();
    let view = await plan();
    expect(view.plan.code).toBe("private-5");
    expect(view.billing.subscription?.past_due).toBe(true);
    // No changing plan on a card that is failing.
    const change = await putPlan(jsonRequest("PUT", "/api/account/plan", { plan: "private-9" }));
    expect(((await change.json()) as { error: string }).error).toBe("payment_failed");

    fake.cancelNow(subscriptionId);
    await deliver();
    view = await plan();
    expect(view.plan.code).toBe("payg");
    expect((await books(accountId)).receivable).toBe(0n);
  });

  it("hands a refund back out of the books", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    fake.refund(fake.subscriptions.get(subscriptionId)!.lastTransactionId!);
    expect(await deliver()).toEqual([200]);
    expect(await books(accountId)).toEqual({ deferred: 0n, psp: 0n, receivable: 0n });
    expect(await db.select().from(providerPayments)).toHaveLength(2);
    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("does not let an operator change a plan the provider bills", async () => {
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

  it("opens the provider's billing page for a customer, and for nobody else", async () => {
    const accountId = await signIn();
    await buy("private-5", accountId);
    const response = await postPortal(jsonRequest("POST", "/api/account/plan/portal"));
    const body = (await response.json()) as { url: string };
    expect(body.url).toMatch(/^http:\/\/creem\.fake\/portal\/cust_/);

    await signIn();
    expect((await postPortal(jsonRequest("POST", "/api/account/plan/portal"))).status).toBe(404);
  });
});

describe("when a notice goes wrong", () => {
  it("keeps a notice it could not apply, says why, and asks for it again", async () => {
    const accountId = await signIn();
    await syncPlans(db, config(), fake.fetch);
    const { checkoutId } = await startCheckout("private-5");
    // The account is gone by the time the payment is reported.
    await db.delete(accounts).where(eq(accounts.id, accountId));
    fake.completeCheckout(checkoutId);
    expect(await deliver({ only: ["subscription.paid"] })).toEqual([500]);
    const [event] = await db.select().from(providerEvents);
    expect(event?.processedAt).toBeNull();
    expect(event?.error).toMatch(/names no account of ours/);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it("acknowledges a notice for something this service did not sell", async () => {
    await signIn();
    await syncPlans(db, config(), fake.fetch);
    const { checkoutId } = await startCheckout("private-5");
    // Sold from the provider's dashboard: no account in its metadata.
    fake.checkouts.get(checkoutId)!.metadata = {};
    fake.completeCheckout(checkoutId);
    expect(await deliver({ only: ["subscription.paid"] })).toEqual([200]);
    const [event] = await db.select().from(providerEvents);
    expect(event?.processedAt).not.toBeNull();
    expect(event?.error).toMatch(/not started from this service/);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it("lets a test purchase lapse once the deployment is live", async () => {
    delete process.env.CREEM_TEST_LEDGER;
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    const periodEnd = fake.subscriptions.get(subscriptionId)!.periodEnd;

    const live = { ...config(), apiKey: "creem_live", mode: "live" as const };
    // Still inside the month it was granted for: left alone.
    let result = await reconcileSubscriptions(db, live, { fetchImpl: fake.fetch });
    expect(result.lapsed).toBe(0);
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("private-5");

    result = await reconcileSubscriptions(db, live, {
      fetchImpl: fake.fetch,
      now: new Date(periodEnd.getTime() + 60 * 60 * 1000),
    });
    expect(result).toEqual({ checked: 0, failures: [], lapsed: 1 });
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("payg");
    // Nothing was asked of the provider: a live key cannot see a test subscription.
    expect(fake.calls.filter((call) => call.startsWith("GET /v1/subscriptions"))).toHaveLength(0);
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

    const { checkoutId } = await startCheckout("private-9");
    fake.completeCheckout(checkoutId);
    await deliver();
    expect((await plan()).plan.code).toBe("private-9");

    const response = await postWebhook(
      new NextRequest(new URL("/api/webhooks/creem", baseUrl), {
        body: late!.body,
        headers: { "creem-signature": late!.signature },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect((await plan()).plan.code).toBe("private-9");
  });

  it("finds a renewal whose notice never arrived", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    fake.endPeriod(subscriptionId);
    fake.takeDeliveries();
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(1);

    // The night after the period we know of ran out.
    const night = new Date(fake.subscriptions.get(subscriptionId)!.periodStart.getTime() + 60 * 60 * 1000);
    const result = await reconcileSubscriptions(db, config(), { fetchImpl: fake.fetch, now: night });
    expect(result).toEqual({ checked: 1, failures: [], lapsed: 0 });
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(2);
    expect((await books(accountId)).psp).toBe(dollars(10));
    expect((await plan()).plan.code).toBe("private-5");

    // And a lapsed one loses its plan.
    fake.cancelNow(subscriptionId);
    fake.takeDeliveries();
    const later = new Date(fake.subscriptions.get(subscriptionId)!.periodEnd.getTime() + 60 * 60 * 1000);
    await reconcileSubscriptions(db, config(), { fetchImpl: fake.fetch, now: later });
    expect((await plan()).plan.code).toBe("payg");
  });
});

describe("deleting an account with a paid plan", () => {
  it("ends the subscription at the provider first", async () => {
    const accountId = await signIn();
    const subscriptionId = await buy("private-5", accountId);
    expect(await cancelForErasure(db, creemSetup(), accountId, fake.fetch)).toBe(1);
    expect(fake.subscriptions.get(subscriptionId)?.status).toBe("canceled");
    expect(await cancelForErasure(db, creemSetup(), accountId, fake.fetch)).toBe(0);
  });

  it("does not delete the account when the provider cannot be told", async () => {
    const accountId = await signIn();
    await buy("private-5", accountId);
    const admin = await signIn({ superadmin: true });
    expect(admin).not.toBe(accountId);
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const response = await deleteAccountAsAdmin(
      jsonRequest("DELETE", `/api/admin/users/${accountId}`),
      { params: Promise.resolve({ accountId }) },
    );
    expect(response.status).toBe(502);
    expect(await db.select().from(accounts).where(eq(accounts.id, accountId))).toHaveLength(1);
  });
});
