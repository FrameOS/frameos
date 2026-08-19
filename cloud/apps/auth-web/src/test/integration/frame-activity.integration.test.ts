// The per-frame audit trail: GET /api/frames/{id}/activity serves the
// frame's slice of audit_events (target->>'frameId'), newest first, with a
// keyset cursor — and the writers that feed it (rename old→new, asset
// writes). cloud/docs/cloud-frames.md "Account hardening".
import { generateKeyPairSync } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  auditEvents,
  createDb,
  frameCommands,
  frames,
  linkedClients,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getFrameActivity } from "../../../app/api/frames/[frameId]/activity/route";
import { POST as deleteFrameAsset } from "../../../app/api/frames/[frameId]/assets/delete/route";
import { POST as renameFrameAsset } from "../../../app/api/frames/[frameId]/assets/rename/route";
import { POST as pushFrameSettings } from "../../../app/api/frames/[frameId]/settings/route";
import { recordAuditEvent } from "../../lib/audit";
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
  headers: async () => new Headers({ "x-real-ip": "203.0.113.9" }),
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

const routeParams = (frameId: string) => ({
  params: Promise.resolve({ frameId }),
});

function getRequest(path: string) {
  return new NextRequest(new URL(path, baseUrl), { method: "GET" });
}

function postJson(path: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: baseUrl },
    method: "POST",
  });
}

function postForm(path: string, fields: Record<string, string>) {
  const form = new URLSearchParams(fields);
  return new NextRequest(new URL(path, baseUrl), {
    body: form,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: baseUrl,
    },
    method: "POST",
  });
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `activity-user-${userCounter}`;
  const email = `activity-${userCounter}@example.com`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Activity User ${userCounter}`,
    email,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, {
    accountId,
    providerIssuer: issuer,
    providerSubject,
  });
  cookieJar.set(sessionCookieName, token);
  return { accountId, email, providerSubject };
}

function rawPublicKeyBase64() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

async function activeFrame(accountId: string, name = "Activity frame") {
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
      connected: true,
      frameosVersion: "2026.8.31",
      hardware: { platform: "pi-zero2w" },
      linkedClientId: client!.id,
      name,
      publicKey: rawPublicKeyBase64(),
      status: "active",
    })
    .returning();
  return frame!;
}

type ActivityResponse = {
  events: {
    actor: { kind: string; ip?: string; email?: string };
    created_at: string;
    detail: string | null;
    event_type: string;
    id: string;
    label: string;
    metadata: unknown;
  }[];
  has_more: boolean;
  next_cursor: { before: string; before_id: string } | null;
};

async function fetchActivity(frameId: string, query = "") {
  const response = await getFrameActivity(
    getRequest(`/api/frames/${frameId}/activity${query}`),
    routeParams(frameId),
  );
  return { response, body: (await response.json()) as ActivityResponse };
}

// Seed `count` frame events with distinct, increasing timestamps so ordering
// and the cursor are unambiguous.
async function seedEvents(
  accountId: string,
  frameId: string,
  count: number,
  startMs = Date.parse("2026-08-01T00:00:00Z"),
) {
  for (let index = 0; index < count; index += 1) {
    await db.insert(auditEvents).values({
      accountId,
      actor: { accountId, providerSubject: "seed" },
      createdAt: new Date(startMs + index * 1000),
      eventType: "frame.command_sent",
      metadata: { seq: index, type: "render" },
      target: { frameId },
    });
  }
}

// Fake device: ack every queued command so asset write routes return.
function ackAll(frameId: string) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const pending = await db
        .select()
        .from(frameCommands)
        .where(
          and(
            eq(frameCommands.frameId, frameId),
            eq(frameCommands.status, "pending"),
          ),
        );
      for (const command of pending) {
        await db
          .update(frameCommands)
          .set({ ackedAt: new Date(), status: "acked" })
          .where(eq(frameCommands.id, command.id));
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

describe("GET /api/frames/{id}/activity", () => {
  it("serves the frame's events newest first with label, detail and actor", async () => {
    const { accountId, email } = await signIn();
    const frame = await activeFrame(accountId);
    const other = await activeFrame(accountId, "Other frame");

    // Account-side write, through the IP-stamping helper.
    await recordAuditEvent(db, {
      accountId,
      actor: { accountId, providerSubject: "p" },
      eventType: "frame.command_sent",
      metadata: { type: "set_current_scene" },
      target: { frameId: frame.id },
    });
    // Device-side write, as the hub records it.
    await db.insert(auditEvents).values({
      accountId,
      actor: { frameId: frame.id, kind: "device" },
      createdAt: new Date(Date.now() + 1000),
      eventType: "frame.connected",
      metadata: { frameosVersion: "2026.8.31" },
      target: { frameId: frame.id },
    });
    // Another frame's event, and an account event with no frame: neither
    // belongs in this feed.
    await db.insert(auditEvents).values({
      accountId,
      actor: { accountId },
      eventType: "frame.command_sent",
      metadata: { type: "reboot" },
      target: { frameId: other.id },
    });
    await db.insert(auditEvents).values({
      accountId,
      actor: { accountId },
      eventType: "account.signed_in",
    });

    const { response, body } = await fetchActivity(frame.id);
    expect(response.status).toBe(200);
    expect(body.events.map((event) => event.event_type)).toEqual([
      "frame.connected",
      "frame.command_sent",
    ]);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();

    const [connected, sent] = body.events;
    expect(connected!.label).toBe("Frame connected");
    expect(connected!.detail).toBe("FrameOS 2026.8.31");
    expect(connected!.actor).toEqual({ kind: "device" });
    expect(sent!.label).toBe("Command sent to a frame");
    expect(sent!.detail).toBe("set current scene");
    expect(sent!.actor).toEqual({
      email,
      ip: "203.0.113.9",
      kind: "account",
    });
    expect(sent!.metadata).toEqual({ type: "set_current_scene" });
  });

  it("pages with the keyset cursor without skipping or repeating rows", async () => {
    const { accountId } = await signIn();
    const frame = await activeFrame(accountId);
    await seedEvents(accountId, frame.id, 7);

    const first = await fetchActivity(frame.id, "?limit=3");
    expect(first.body.events).toHaveLength(3);
    expect(first.body.has_more).toBe(true);
    expect(first.body.next_cursor).not.toBeNull();
    const seqs = (page: ActivityResponse) =>
      page.events.map((event) => (event.metadata as { seq: number }).seq);
    expect(seqs(first.body)).toEqual([6, 5, 4]);

    const cursor = first.body.next_cursor!;
    const second = await fetchActivity(
      frame.id,
      `?limit=3&before=${encodeURIComponent(cursor.before)}&before_id=${cursor.before_id}`,
    );
    expect(seqs(second.body)).toEqual([3, 2, 1]);
    expect(second.body.has_more).toBe(true);

    const third = await fetchActivity(
      frame.id,
      `?limit=3&before_id=${second.body.next_cursor!.before_id}`,
    );
    expect(seqs(third.body)).toEqual([0]);
    expect(third.body.has_more).toBe(false);
    expect(third.body.next_cursor).toBeNull();

    // Same-millisecond rows: the before_id cursor compares against the
    // cursor row's own stored timestamp, so microsecond neighbours are
    // neither skipped nor repeated.
    const instant = new Date("2026-08-02T00:00:00.123Z");
    const sameMs = [];
    for (let index = 0; index < 3; index += 1) {
      const [row] = await db
        .insert(auditEvents)
        .values({
          accountId,
          actor: { accountId },
          createdAt: instant,
          eventType: "frame.command_sent",
          metadata: { seq: 100 + index, type: "render" },
          target: { frameId: frame.id },
        })
        .returning({ id: auditEvents.id });
      sameMs.push(row!.id);
    }
    const pageA = await fetchActivity(frame.id, "?limit=2");
    expect(pageA.body.events).toHaveLength(2);
    const pageB = await fetchActivity(
      frame.id,
      `?limit=2&before_id=${pageA.body.next_cursor!.before_id}`,
    );
    const ids = [...pageA.body.events, ...pageB.body.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of sameMs) {
      expect(ids).toContain(id);
    }
  });

  it("caps the page size, and refuses a malformed cursor", async () => {
    const { accountId } = await signIn();
    const frame = await activeFrame(accountId);
    await seedEvents(accountId, frame.id, 2);

    const capped = await fetchActivity(frame.id, "?limit=99999");
    expect(capped.response.status).toBe(200);
    expect(capped.body.events).toHaveLength(2);

    const bad = await getFrameActivity(
      getRequest(`/api/frames/${frame.id}/activity?before=yesterday`),
      routeParams(frame.id),
    );
    expect(bad.status).toBe(400);
    const badId = await getFrameActivity(
      getRequest(`/api/frames/${frame.id}/activity?before_id=nope`),
      routeParams(frame.id),
    );
    expect(badId.status).toBe(400);
  });

  it("is invisible across accounts and without a session", async () => {
    const owner = await signIn();
    const frame = await activeFrame(owner.accountId);
    await seedEvents(owner.accountId, frame.id, 1);

    await signIn(); // someone else
    const foreign = await fetchActivity(frame.id);
    expect(foreign.response.status).toBe(404);

    cookieJar.clear();
    const anonymous = await getFrameActivity(
      getRequest(`/api/frames/${frame.id}/activity`),
      routeParams(frame.id),
    );
    expect(anonymous.status).toBe(401);
  });
});

describe("writers that feed the frame activity feed", () => {
  it("records a rename as old → new next to the settings push", async () => {
    const { accountId } = await signIn();
    const frame = await activeFrame(accountId, "Kitchen");

    const renamed = await pushFrameSettings(
      postJson(`/api/frames/${frame.id}/settings`, {
        settings: { name: "Hallway" },
      }),
      routeParams(frame.id),
    );
    expect(renamed.status).toBe(200);

    const { body } = await fetchActivity(frame.id);
    expect(body.events.map((event) => event.event_type)).toEqual([
      "frame.renamed",
      "frame.settings_pushed",
    ]);
    expect(body.events[0]!.detail).toBe("Kitchen → Hallway");
    expect(body.events[0]!.metadata).toEqual({ from: "Kitchen", to: "Hallway" });
    expect(body.events[1]!.detail).toBe("name");

    // Pushing the same name again is not a rename.
    await pushFrameSettings(
      postJson(`/api/frames/${frame.id}/settings`, {
        settings: { name: "Hallway" },
      }),
      routeParams(frame.id),
    );
    const again = await fetchActivity(frame.id);
    expect(
      again.body.events.filter((event) => event.event_type === "frame.renamed"),
    ).toHaveLength(1);
  });

  it("records acked asset writes with their paths", async () => {
    const { accountId } = await signIn();
    const frame = await activeFrame(accountId);
    const stop = ackAll(frame.id);
    try {
      const deleted = await deleteFrameAsset(
        postForm(`/api/frames/${frame.id}/assets/delete`, {
          path: "photos/old.jpg",
        }),
        routeParams(frame.id),
      );
      expect(deleted.status).toBe(200);
      const renamed = await renameFrameAsset(
        postForm(`/api/frames/${frame.id}/assets/rename`, {
          dst: "photos/b.jpg",
          src: "photos/a.jpg",
        }),
        routeParams(frame.id),
      );
      expect(renamed.status).toBe(200);
    } finally {
      await stop();
    }

    const { body } = await fetchActivity(frame.id);
    expect(body.events.map((event) => event.event_type)).toEqual([
      "frame.asset_renamed",
      "frame.asset_deleted",
    ]);
    expect(body.events[0]!.detail).toBe("photos/a.jpg → photos/b.jpg");
    expect(body.events[1]!.detail).toBe("photos/old.jpg");
    expect(body.events[1]!.actor.kind).toBe("account");
  });
});
