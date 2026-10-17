// The frame-level local network access switch on a cloud-managed frame: the two routes
// (POST /api/frames/{id}/lan_access/challenge, POST /api/frames/{id}/lan_access)
// enqueue their verb on the real command queue and wait for the device's
// ack, which a fake device writes the way the hub would. Shapes: the routes'
// comments in src/lib/frame-lan-access.ts.
import { generateKeyPairSync } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { createDb, frameCommands, frames, linkedClients, upsertAccountFromIdentity } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as sendCommand } from "../../../app/api/frames/[frameId]/command/route";
import { GET as listCommands } from "../../../app/api/frames/[frameId]/commands/route";
import { POST as postChallenge } from "../../../app/api/frames/[frameId]/lan_access/challenge/route";
import { POST as postLanAccess } from "../../../app/api/frames/[frameId]/lan_access/route";
import { GET as getFrame } from "../../../app/api/frames/[frameId]/route";
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
});

function postJson(path: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: baseUrl },
    method: "POST",
  });
}

const routeParams = (frameId: string) => ({ params: Promise.resolve({ frameId }) });

async function signIn() {
  userCounter += 1;
  const providerSubject = `lan-access-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `LAN Access User ${userCounter}`,
    email: `lan-access-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

function rawPublicKeyBase64() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

async function activeFrame(options: { connected?: boolean; hardware?: Record<string, unknown> | null } = {}) {
  const accountId = await signIn();
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: "LAN frame",
      tokenReference: hashSecret(`fc_link_lan_${accountId}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      connected: options.connected ?? true,
      hardware:
        options.hardware === undefined ? { lanAccess: false, panel: "7.3e", platform: "buildroot" } : options.hardware,
      linkedClientId: client!.id,
      name: "LAN frame",
      publicKey: rawPublicKeyBase64(),
      status: "active",
    })
    .returning();
  return frame!;
}

async function commandsOfType(frameId: string, type: string) {
  return db
    .select()
    .from(frameCommands)
    .where(and(eq(frameCommands.frameId, frameId), eq(frameCommands.type, type)))
    .orderBy(frameCommands.createdAt);
}

// A stand-in for the device behind the hub: answers every pending command
// the way `answer` says, as the hub's handleAck would record it.
function fakeDevice(
  frameId: string,
  answer: (command: typeof frameCommands.$inferSelect) => { ok: boolean; error?: string },
) {
  const seen: (typeof frameCommands.$inferSelect)[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const pending = await db
        .select()
        .from(frameCommands)
        .where(and(eq(frameCommands.frameId, frameId), eq(frameCommands.status, "pending")))
        .orderBy(frameCommands.createdAt);
      for (const command of pending) {
        seen.push(command);
        const reply = answer(command);
        await db
          .update(frameCommands)
          .set({
            ackedAt: new Date(),
            error: reply.ok ? null : (reply.error ?? "error"),
            status: reply.ok ? "acked" : "failed",
          })
          .where(eq(frameCommands.id, command.id));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  return {
    seen,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

describe("POST /api/frames/{id}/lan_access/challenge", () => {
  it("queues lan_access_challenge and says shown once the frame acks", async () => {
    const frame = await activeFrame();
    const device = fakeDevice(frame.id, () => ({ ok: true }));
    try {
      const response = await postChallenge(postJson(`/api/frames/${frame.id}/lan_access/challenge`, {}), routeParams(frame.id));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ expires_in_seconds: 300, status: "shown" });
    } finally {
      await device.stop();
    }
    expect(device.seen.map((command) => command.type)).toEqual(["lan_access_challenge"]);
    expect(device.seen[0]!.payload).toEqual({});
    // Ten minutes from now: the frame is awake, so no wake forecast to add.
    const expiresIn = device.seen[0]!.expiresAt!.getTime() - device.seen[0]!.createdAt.getTime();
    expect(expiresIn).toBeGreaterThan(9 * 60 * 1000);
    expect(expiresIn).toBeLessThanOrEqual(10 * 60 * 1000 + 5_000);
  });

  it("answers no_panel from a frame with nothing to draw on", async () => {
    const frame = await activeFrame();
    const device = fakeDevice(frame.id, () => ({ error: "no_panel", ok: false }));
    try {
      const response = await postChallenge(postJson(`/api/frames/${frame.id}/lan_access/challenge`, {}), routeParams(frame.id));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ detail: "This frame has no screen to show a code on.", error: "no_panel" });
    } finally {
      await device.stop();
    }
  });

  it("says queued for an offline frame and supersedes the older challenge", async () => {
    const frame = await activeFrame({ connected: false });
    const first = await postChallenge(postJson(`/api/frames/${frame.id}/lan_access/challenge`, {}), routeParams(frame.id));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "queued" });
    const second = await postChallenge(postJson(`/api/frames/${frame.id}/lan_access/challenge`, {}), routeParams(frame.id));
    expect(await second.json()).toEqual({ status: "queued" });

    const rows = await commandsOfType(frame.id, "lan_access_challenge");
    expect(rows.map((row) => [row.status, row.error])).toEqual([
      ["expired", "superseded"],
      ["pending", null],
    ]);
  });

  it("refuses a frame whose firmware does not report the switch, queueing nothing", async () => {
    const frame = await activeFrame({ hardware: { platform: "esp32s3" } });
    const response = await postChallenge(postJson(`/api/frames/${frame.id}/lan_access/challenge`, {}), routeParams(frame.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: "Update this frame's FrameOS first.", error: "unsupported" });
    expect(await commandsOfType(frame.id, "lan_access_challenge")).toHaveLength(0);
  });
});

describe("POST /api/frames/{id}/lan_access", () => {
  it("turns on with the code, then the summary and the row say so", async () => {
    const frame = await activeFrame();
    const device = fakeDevice(frame.id, () => ({ ok: true }));
    try {
      const response = await postLanAccess(
        postJson(`/api/frames/${frame.id}/lan_access`, { code: "482 913", enabled: true }),
        routeParams(frame.id),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ lan_access: true, status: "applied" });
    } finally {
      await device.stop();
    }
    expect(device.seen.map((command) => [command.type, command.payload])).toEqual([
      ["lan_access_set", { code: "482913", enabled: true }],
    ]);

    // The mirror: one key rewritten, the rest of the report kept.
    const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(row!.hardware).toEqual({ lanAccess: true, panel: "7.3e", platform: "buildroot" });
    const detail = await getFrame(new NextRequest(new URL(`/api/frames/${frame.id}`, baseUrl)), routeParams(frame.id));
    expect((await detail.json()).frame.lan_access).toBe(true);
  });

  it("turns off without a code", async () => {
    const frame = await activeFrame({ hardware: { lanAccess: true, platform: "esp32s3" } });
    const device = fakeDevice(frame.id, () => ({ ok: true }));
    try {
      const response = await postLanAccess(
        postJson(`/api/frames/${frame.id}/lan_access`, { enabled: false }),
        routeParams(frame.id),
      );
      expect(await response.json()).toEqual({ lan_access: false, status: "applied" });
    } finally {
      await device.stop();
    }
    expect(device.seen.map((command) => command.payload)).toEqual([{ enabled: false }]);
    const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(row!.hardware).toEqual({ lanAccess: false, platform: "esp32s3" });
  });

  it("answers a wrong code with 403 invalid_code and keeps the switch off", async () => {
    const frame = await activeFrame();
    const device = fakeDevice(frame.id, () => ({ error: "invalid_code", ok: false }));
    try {
      const response = await postLanAccess(
        postJson(`/api/frames/${frame.id}/lan_access`, { code: "000000", enabled: true }),
        routeParams(frame.id),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        detail: "That code is not right. Check the frame and try again.",
        error: "invalid_code",
      });
    } finally {
      await device.stop();
    }
    const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect((row!.hardware as Record<string, unknown>).lanAccess).toBe(false);
  });

  it("refuses a malformed code without spending one of the frame's attempts", async () => {
    const frame = await activeFrame();
    for (const body of [{ enabled: true }, { code: "12345", enabled: true }, { enabled: "on" }]) {
      const response = await postLanAccess(postJson(`/api/frames/${frame.id}/lan_access`, body), routeParams(frame.id));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await commandsOfType(frame.id, "lan_access_set")).toHaveLength(0);
  });

  it("says queued for an offline frame, and the queue listing never shows the code", async () => {
    const frame = await activeFrame({ connected: false });
    const response = await postLanAccess(
      postJson(`/api/frames/${frame.id}/lan_access`, { code: "731046", enabled: true }),
      routeParams(frame.id),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "queued" });

    const listing = await listCommands(new NextRequest(new URL(`/api/frames/${frame.id}/commands`, baseUrl)), routeParams(frame.id));
    const text = await listing.text();
    expect(JSON.parse(text).commands.map((command: { type: string }) => command.type)).toEqual(["lan_access_set"]);
    expect(text).not.toContain("731046");
    const detail = await getFrame(new NextRequest(new URL(`/api/frames/${frame.id}`, baseUrl)), routeParams(frame.id));
    const detailText = await detail.text();
    expect(JSON.parse(detailText).frame.pending_command_types).toEqual(["lan_access_set"]);
    expect(detailText).not.toContain("731046");
    // Nor does the activity trail.
    const audit = await db.execute<{ metadata: unknown }>(sql`select metadata from audit_events`);
    expect(JSON.stringify(audit)).not.toContain("731046");
  });
});

describe("the generic command route", () => {
  it("does not send either local network access verb", async () => {
    const frame = await activeFrame();
    for (const type of ["lan_access_challenge", "lan_access_set"]) {
      const response = await sendCommand(
        postJson(`/api/frames/${frame.id}/command`, { code: "123456", enabled: true, type }),
        routeParams(frame.id),
      );
      expect(response.status, type).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_command" });
    }
    expect(await commandsOfType(frame.id, "lan_access_set")).toHaveLength(0);
  });
});
