// GET /api/frames/{id}/image — the frame's current rendered image, backed by
// the image_get verb and the frame_asset_files cache.
//
// The ?t= query param carries intent (entityImagesModel): t=-1 is a tile
// filling in passively — serve whatever is cached immediately and refresh
// behind it — while a real timestamp is a deliberate "give me the current
// image" (the refresh button, a render signal), which must wait for the
// device's answer instead of echoing the stale cache back at the click that
// asked for fresh bytes. That echo is exactly how "the frame shows the new
// render but Refresh shows the old image" happened on a live esp32 frame.
import { generateKeyPairSync } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  createDb,
  frameAssetFiles,
  frameCommands,
  linkedClients,
  frames,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getFrameImage } from "../../../app/api/frames/[frameId]/image/route";
import { frameImageAssetPath } from "../../lib/frames";
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

function imageRequest(frameId: string, t?: string) {
  const query = t === undefined ? "" : `?t=${t}`;
  return new NextRequest(
    new URL(`/api/frames/${frameId}/image${query}`, baseUrl),
    { method: "GET" },
  );
}

const routeParams = (frameId: string) => ({
  params: Promise.resolve({ frameId }),
});

async function signIn() {
  userCounter += 1;
  const providerSubject = `frame-image-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Frame Image User ${userCounter}`,
    email: `frame-image-${userCounter}@example.com`,
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
  return accountId;
}

function rawPublicKeyBase64() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

async function createFrame(accountId: string, status = "active") {
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: "Frame image frame",
      tokenReference: hashSecret(`fc_link_frame_image_${accountId}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: client!.id,
      name: "Frame image frame",
      publicKey: rawPublicKeyBase64(),
      status,
    })
    .returning();
  return frame!;
}

async function cacheImage(frameId: string, bytes: string, ageMs: number) {
  await db
    .delete(frameAssetFiles)
    .where(
      and(
        eq(frameAssetFiles.frameId, frameId),
        eq(frameAssetFiles.path, frameImageAssetPath),
      ),
    );
  await db.insert(frameAssetFiles).values({
    content: Buffer.from(bytes),
    contentType: "image/bmp",
    frameId,
    path: frameImageAssetPath,
    sizeBytes: bytes.length,
    thumb: false,
    updatedAt: new Date(Date.now() - ageMs),
  });
}

async function outstandingImageGets(frameId: string) {
  return db
    .select()
    .from(frameCommands)
    .where(
      and(
        eq(frameCommands.frameId, frameId),
        eq(frameCommands.type, "image_get"),
        inArray(frameCommands.status, ["pending", "sent"]),
      ),
    );
}

describe("GET /api/frames/{id}/image freshness", () => {
  it("serves a stale image immediately on a passive load and refreshes behind it", async () => {
    const accountId = await signIn();
    const frame = await createFrame(accountId);
    await cacheImage(frame.id, "old-render", 60_000);

    const started = Date.now();
    const response = await getFrameImage(
      imageRequest(frame.id, "-1"),
      routeParams(frame.id),
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "old-render",
    );
    // No long-poll on the passive path — the tile must fill in instantly.
    expect(Date.now() - started).toBeLessThan(500);
    // …but the stale copy still queues a device fetch behind it.
    expect(await outstandingImageGets(frame.id)).toHaveLength(1);
  });

  it("waits for the device's fresh image on an explicit refresh", async () => {
    const accountId = await signIn();
    const frame = await createFrame(accountId);
    await cacheImage(frame.id, "old-render", 60_000);

    // The device answering the queued image_get, a moment after the request
    // starts long-polling.
    const deviceReply = setTimeout(() => {
      void cacheImage(frame.id, "new-render", 0);
    }, 1200);
    try {
      const response = await getFrameImage(
        imageRequest(frame.id, String(Math.floor(Date.now() / 1000))),
        routeParams(frame.id),
      );
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
        "new-render",
      );
    } finally {
      clearTimeout(deviceReply);
    }
    expect(await outstandingImageGets(frame.id)).toHaveLength(1);
  }, 15_000);

  it("serves a fresh-enough cache immediately, even on an explicit refresh", async () => {
    const accountId = await signIn();
    const frame = await createFrame(accountId);
    await cacheImage(frame.id, "recent-render", 5_000);

    const response = await getFrameImage(
      imageRequest(frame.id, String(Math.floor(Date.now() / 1000))),
      routeParams(frame.id),
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "recent-render",
    );
    // Under the staleness window nothing needs re-fetching.
    expect(await outstandingImageGets(frame.id)).toHaveLength(0);
  });

  it("falls back to the stale image when the device refuses the fetch", async () => {
    const accountId = await signIn();
    const frame = await createFrame(accountId);
    await cacheImage(frame.id, "old-render", 60_000);
    // A refusal from moments ago (busy mid-render, rebooting…).
    await db.insert(frameCommands).values({
      error: "busy",
      frameId: frame.id,
      status: "failed",
      type: "image_get",
    });

    const response = await getFrameImage(
      imageRequest(frame.id, String(Math.floor(Date.now() / 1000))),
      routeParams(frame.id),
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "old-render",
    );
  }, 15_000);

  it("keeps answering 409 for a frame no board has enrolled as", async () => {
    const accountId = await signIn();
    const frame = await createFrame(accountId, "pending");

    const response = await getFrameImage(
      imageRequest(frame.id, String(Math.floor(Date.now() / 1000))),
      routeParams(frame.id),
    );
    expect(response.status).toBe(409);
  });
});
