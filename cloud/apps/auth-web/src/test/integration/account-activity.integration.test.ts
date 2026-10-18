// The account activity feed: GET /api/account/activity (filters, search,
// time range, keyset cursor) and GET /api/account/activity/histogram (counts
// per bucket over a span). Both read src/lib/account-activity.ts, so the
// bars and the rows describe the same slice.
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { auditEvents, createDb, frames, linkedClients, upsertAccountFromIdentity } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getActivity } from "../../../app/api/account/activity/route";
import { GET as getHistogram } from "../../../app/api/account/activity/histogram/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { hashSecret } from "../../lib/secrets";
import { createSession, sessionCookieName } from "../../lib/session";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
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
});

function getRequest(path: string) {
  return new NextRequest(new URL(path, baseUrl), { method: "GET" });
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `activity-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Activity User ${userCounter}`,
    email: `activity-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

async function frameNamed(accountId: string, name: string) {
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: name,
      tokenReference: hashSecret(`fc_link_activity_${accountId}_${name}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      frameosVersion: "2026.8.31",
      hardware: { platform: "pi-zero2w" },
      linkedClientId: client!.id,
      name,
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      status: "active",
    })
    .returning();
  return frame!;
}

async function event(
  accountId: string,
  eventType: string,
  createdAt: Date,
  extra: { metadata?: unknown; target?: unknown } = {},
) {
  await db.insert(auditEvents).values({
    accountId,
    actor: { accountId, ip: "203.0.113.9", kind: "account" },
    createdAt,
    eventType,
    metadata: extra.metadata ?? null,
    target: extra.target ?? null,
  });
}

type FeedResponse = {
  events: { created_at: string; frame_name: string | null; id: string; label: string }[];
  has_more: boolean;
  next_cursor: { before: string; before_id: string } | null;
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600 * 1000);

describe("GET /api/account/activity", () => {
  it("needs a session", async () => {
    const response = await getActivity(getRequest("/api/account/activity"));
    expect(response.status).toBe(401);
  });

  it("filters by family, searches labels and frame names, and bounds by time", async () => {
    const accountId = await signIn();
    const other = await upsertAccountFromIdentity(db, {
      displayName: "Someone else",
      email: "else@example.com",
      emailVerified: true,
      providerIssuer: issuer,
      providerKey: "google",
      providerSubject: "else",
    });
    const kitchen = await frameNamed(accountId, "Kitchen frame");
    await event(accountId, "account.signed_in", hoursAgo(1));
    await event(accountId, "frame.renamed", hoursAgo(2), {
      metadata: { from: "Old", to: "Kitchen frame" },
      target: { frameId: kitchen.id, kind: "frame" },
    });
    await event(accountId, "backup.saved", hoursAgo(50), { metadata: { name: "pantry" } });
    await event(accountId, "backend.inventory_synced", hoursAgo(1));
    await event(other.accountId, "account.signed_in", hoursAgo(1));

    const all = (await (await getActivity(getRequest("/api/account/activity"))).json()) as FeedResponse;
    expect(all.events.map((row) => row.label)).toEqual([
      "Signed in",
      "Frame renamed",
      "Backup saved",
    ]);
    expect(all.events[1]?.frame_name).toBe("Kitchen frame");

    const framesOnly = (await (
      await getActivity(getRequest("/api/account/activity?group=frames"))
    ).json()) as FeedResponse;
    expect(framesOnly.events.map((row) => row.label)).toEqual(["Frame renamed"]);

    const byLabel = (await (
      await getActivity(getRequest("/api/account/activity?q=signed"))
    ).json()) as FeedResponse;
    expect(byLabel.events.map((row) => row.label)).toEqual(["Signed in"]);

    const byFrame = (await (
      await getActivity(getRequest("/api/account/activity?q=kitchen"))
    ).json()) as FeedResponse;
    expect(byFrame.events.map((row) => row.label)).toEqual(["Frame renamed"]);

    const byMetadata = (await (
      await getActivity(getRequest("/api/account/activity?q=pantry"))
    ).json()) as FeedResponse;
    expect(byMetadata.events.map((row) => row.label)).toEqual(["Backup saved"]);

    const recent = (await (
      await getActivity(
        getRequest(
          `/api/account/activity?from=${hoursAgo(3).toISOString()}&to=${hoursAgo(1.5).toISOString()}`,
        ),
      )
    ).json()) as FeedResponse;
    expect(recent.events.map((row) => row.label)).toEqual(["Frame renamed"]);

    expect((await getActivity(getRequest("/api/account/activity?group=nope"))).status).toBe(400);
    expect((await getActivity(getRequest("/api/account/activity?from=yesterday"))).status).toBe(400);
  });

  it("pages with a keyset cursor that keeps the filters", async () => {
    const accountId = await signIn();
    for (let i = 0; i < 5; i += 1) {
      await event(accountId, "account.signed_in", hoursAgo(i + 1));
      await event(accountId, "backup.saved", hoursAgo(i + 1));
    }
    const first = (await (
      await getActivity(getRequest("/api/account/activity?group=backups&limit=2"))
    ).json()) as FeedResponse;
    expect(first.events).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).not.toBeNull();

    const seen = first.events.map((row) => row.id);
    let cursor = first.next_cursor;
    while (cursor) {
      const page = (await (
        await getActivity(
          getRequest(
            `/api/account/activity?group=backups&limit=2&before=${cursor.before}&before_id=${cursor.before_id}`,
          ),
        )
      ).json()) as FeedResponse;
      expect(page.events.every((row) => row.label === "Backup saved")).toBe(true);
      seen.push(...page.events.map((row) => row.id));
      cursor = page.next_cursor;
    }
    expect(new Set(seen).size).toBe(5);
  });
});

describe("GET /api/account/activity/histogram", () => {
  it("counts events per bucket over the span, under the same filters", async () => {
    const accountId = await signIn();
    await event(accountId, "account.signed_in", hoursAgo(1));
    await event(accountId, "account.signed_in", hoursAgo(1.2));
    await event(accountId, "backup.saved", hoursAgo(1.1));
    await event(accountId, "account.signed_in", hoursAgo(30));
    await event(accountId, "account.signed_in", hoursAgo(24 * 40));

    const day = (await (
      await getHistogram(getRequest("/api/account/activity/histogram?span=24h"))
    ).json()) as { buckets: { count: number; start: string }[]; step_seconds: number };
    expect(day.step_seconds).toBe(3600);
    expect(day.buckets.length).toBeGreaterThanOrEqual(24);
    expect(day.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
    expect(day.buckets.every((b) => Number.isInteger(new Date(b.start).getTime() / 1000 / 3600))).toBe(true);

    const month = (await (
      await getHistogram(getRequest("/api/account/activity/histogram?span=30d&group=account"))
    ).json()) as { buckets: { count: number }[]; step_seconds: number };
    expect(month.step_seconds).toBe(86400);
    expect(month.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);

    const all = (await (
      await getHistogram(getRequest("/api/account/activity/histogram?span=all"))
    ).json()) as { buckets: { count: number }[] };
    expect(all.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(5);

    expect((await getHistogram(getRequest("/api/account/activity/histogram?span=1y"))).status).toBe(400);
  });
});
