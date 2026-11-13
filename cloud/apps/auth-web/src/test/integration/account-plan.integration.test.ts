// The plan route without a payment provider: nothing can be bought, an
// account can stop paying, and the price list lives on the product site.
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { createDb, upsertAccountFromIdentity } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getPlan, PUT as putPlan } from "../../../app/api/account/plan/route";
import { GET as getPricing } from "../../../app/pricing/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

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
const db = createDb();
let userCounter = 0;

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

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
  await db.execute(sql`
    INSERT INTO billing_plans ("code", "name", "price_micros", "margin_basis_points", "entitlements")
    VALUES ('payg', 'Free', 0, 10000, '{"frames": 20}'::jsonb),
           ('private-5', 'Private', 5000000, 10000, '{"frames": 60}'::jsonb)
    ON CONFLICT ("code") DO NOTHING
  `);
});

async function signIn() {
  userCounter += 1;
  const providerSubject = `plan-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Plan Tester ${userCounter}`,
    email: `plan-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

function putJson(path: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: baseUrl },
    method: "PUT",
  });
}

describe("the plan route without a payment provider", () => {
  it("offers nothing for sale and names the price list", async () => {
    await signIn();
    const response = await getPlan(new NextRequest(new URL("/api/account/plan", baseUrl)));
    const view = (await response.json()) as {
      billing: { checkout: boolean; subscription: unknown };
      catalog: { groups: { available: boolean; key: string; stops: { purchasable: boolean }[] }[] };
      links: { pricing: string; refunds: string };
      self_serve: boolean;
    };
    expect(view.billing).toEqual({
      checkout: false,
      manage: false,
      mode: null,
      prices_exclude_tax: false,
      subscription: null,
      tax_label: null,
    });
    expect(view.self_serve).toBe(false);
    expect(view.catalog.groups.map((group) => [group.key, group.available])).toEqual([
      ["free", true],
      ["private", false],
      ["business", false],
    ]);
    expect(view.catalog.groups.flatMap((group) => group.stops).some((stop) => stop.purchasable)).toBe(false);
    expect(view.links).toEqual({
      pricing: "https://frameos.net/pricing/",
      refunds: `${baseUrl}/legal/refunds`,
    });
  });

  it("refuses to sell a paid plan and lets an account stop paying", async () => {
    await signIn();
    const paid = await putPlan(putJson("/api/account/plan", { plan: "private-5" }));
    expect(paid.status).toBe(503);
    const free = await putPlan(putJson("/api/account/plan", { plan: "payg" }));
    expect(free.status).toBe(200);
  });

  it("sends a visitor to the product site's price list and an account to its own plans", async () => {
    const visitor = await getPricing();
    expect(visitor.status).toBe(307);
    expect(visitor.headers.get("location")).toBe("https://frameos.net/pricing/");

    await signIn();
    const account = await getPricing();
    expect(account.headers.get("location")).toBe(`${baseUrl}/account/usage`);
  });
});
