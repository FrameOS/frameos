// The cloud asset surface (cloud/docs/cloud-workspace-gaps.md + the user's
// "make sure we can also access the assets"): GET /assets serves the hub's
// cached listing and queues assets_list; GET /asset serves cached bytes and
// queues asset_get; POST /event/<name> translates the backend's event surface
// onto queue verbs. Wire contract: docs/cloud-frames.md.
import { generateKeyPairSync } from "node:crypto";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  createDb,
  frameAssetFiles,
  frameCommands,
  frames,
  linkedClients,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getFrameAssets } from "../../../app/api/frames/[frameId]/assets/route";
import { GET as getFrameAsset } from "../../../app/api/frames/[frameId]/asset/route";
import { DELETE as deleteFrame } from "../../../app/api/frames/[frameId]/route";
import { POST as postFrameEvent } from "../../../app/api/frames/[frameId]/event/[eventName]/route";
import {
  maxAssetCacheBytesPerFrame,
  maxAssetFileBytes,
  maxAssetFilesPerFrame,
  parseAssetEntries,
  storeFrameAssetFile,
  storeFrameAssetListing,
} from "../../lib/frames";
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

const assetsParams = (frameId: string) => ({
  params: Promise.resolve({ frameId }),
});
const eventParams = (frameId: string, eventName: string) => ({
  params: Promise.resolve({ eventName, frameId }),
});

async function signIn() {
  userCounter += 1;
  const providerSubject = `asset-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Asset User ${userCounter}`,
    email: `assets-${userCounter}@example.com`,
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

async function activeFrame(status = "active", connected = true) {
  const accountId = await signIn();
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: "Asset frame",
      tokenReference: hashSecret(`fc_link_assets_${accountId}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      // The listing endpoint only asks a frame that is live on the hub, so
      // the fixture defaults to connected.
      connected,
      linkedClientId: client!.id,
      name: "Asset frame",
      publicKey: rawPublicKeyBase64(),
      status,
    })
    .returning();
  return { accountId, frame: frame! };
}

async function commandsOfType(frameId: string, type: string) {
  return db
    .select()
    .from(frameCommands)
    .where(
      and(eq(frameCommands.frameId, frameId), eq(frameCommands.type, type)),
    )
    .orderBy(frameCommands.createdAt);
}

describe("GET /api/frames/{id}/assets", () => {
  it("queues assets_list on a cold cache and reports refreshing", async () => {
    const { frame } = await activeFrame();
    const response = await getFrameAssets(
      getRequest(`/api/frames/${frame.id}/assets`),
      assetsParams(frame.id),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.assets).toEqual([]);
    expect(payload.cache).toEqual({ refreshing: true, retry_after: 2 });
    const commands = await commandsOfType(frame.id, "assets_list");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.status).toBe("pending");

    // A second poll rides the outstanding command instead of stacking one.
    await getFrameAssets(
      getRequest(`/api/frames/${frame.id}/assets`),
      assetsParams(frame.id),
    );
    expect(await commandsOfType(frame.id, "assets_list")).toHaveLength(1);
  });

  it("serves the stored listing and refreshes only on request", async () => {
    const { frame } = await activeFrame();
    await storeFrameAssetListing(
      db,
      frame.id,
      [
        { mtime: 1700000000, path: "photos", size: 0, is_dir: true },
        { mtime: 1700000001, path: "photos/cat.jpg", size: 5 },
      ],
      false,
    );
    const response = await getFrameAssets(
      getRequest(`/api/frames/${frame.id}/assets`),
      assetsParams(frame.id),
    );
    const payload = await response.json();
    expect(payload.assets).toHaveLength(2);
    expect(payload.assets[1].path).toBe("photos/cat.jpg");
    expect(payload.cache).toBeUndefined();
    expect(await commandsOfType(frame.id, "assets_list")).toHaveLength(0);

    const refresh = await getFrameAssets(
      getRequest(`/api/frames/${frame.id}/assets?refresh=1`),
      assetsParams(frame.id),
    );
    const refreshed = await refresh.json();
    expect(refreshed.assets).toHaveLength(2);
    expect(refreshed.cache).toEqual({ refreshing: true, retry_after: 2 });
    expect(await commandsOfType(frame.id, "assets_list")).toHaveLength(1);
  });

  it("never queues toward a pending frame", async () => {
    const { frame } = await activeFrame("pending");
    const response = await getFrameAssets(
      getRequest(`/api/frames/${frame.id}/assets`),
      assetsParams(frame.id),
    );
    const payload = await response.json();
    expect(payload.assets).toEqual([]);
    expect(payload.cache).toBeUndefined();
    expect(await commandsOfType(frame.id, "assets_list")).toHaveLength(0);
  });

  it("never queues toward a disconnected frame, and does not report refreshing", async () => {
    // A disconnected frame used to turn the panel into an infinite loop:
    // every poll re-enqueued assets_list (the previous one kept expiring
    // unanswered), every response said refreshing, and the panel refetched
    // every 2 s until the tab closed.
    const { frame } = await activeFrame("active", false);
    const response = await getFrameAssets(
      getRequest(`/api/frames/${frame.id}/assets?refresh=1`),
      assetsParams(frame.id),
    );
    const payload = await response.json();
    expect(payload.assets).toEqual([]);
    expect(payload.cache).toBeUndefined();
    expect(await commandsOfType(frame.id, "assets_list")).toHaveLength(0);
  });
});

describe("GET /api/frames/{id}/asset", () => {
  it("serves cached bytes with the stored content type", async () => {
    const { frame } = await activeFrame();
    await storeFrameAssetFile(db, frame.id, {
      content: Buffer.from("jpeg-bytes"),
      contentType: "image/jpeg",
      path: "photos/cat.jpg",
      thumb: false,
    });
    const response = await getFrameAsset(
      getRequest(
        `/api/frames/${frame.id}/asset?path=photos/cat.jpg&mode=download&filename=cat.jpg`,
      ),
      assetsParams(frame.id),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "jpeg-bytes",
    );
    // Fresh cache: no fetch queued.
    expect(await commandsOfType(frame.id, "asset_get")).toHaveLength(0);
  });

  it("keeps thumb and original cache entries apart", async () => {
    const { frame } = await activeFrame();
    await storeFrameAssetFile(db, frame.id, {
      content: Buffer.from("original"),
      contentType: "image/png",
      path: "a.png",
      thumb: false,
    });
    await storeFrameAssetFile(db, frame.id, {
      content: Buffer.from("thumbnail"),
      contentType: "image/jpeg",
      path: "a.png",
      thumb: true,
    });
    const thumb = await getFrameAsset(
      getRequest(`/api/frames/${frame.id}/asset?path=a.png&thumb=1`),
      assetsParams(frame.id),
    );
    expect(Buffer.from(await thumb.arrayBuffer()).toString()).toBe("thumbnail");
  });

  it("refuses traversal and absolute paths outright", async () => {
    const { frame } = await activeFrame();
    for (const path of ["../secrets", "a/../../b", ""]) {
      const response = await getFrameAsset(
        getRequest(
          `/api/frames/${frame.id}/asset?path=${encodeURIComponent(path)}`,
        ),
        assetsParams(frame.id),
      );
      expect(response.status).toBe(400);
    }
    expect(await commandsOfType(frame.id, "asset_get")).toHaveLength(0);
  });

  it("surfaces a device refusal instead of waiting out the poll", async () => {
    const { frame } = await activeFrame();
    const pending = getFrameAsset(
      getRequest(`/api/frames/${frame.id}/asset?path=missing.png`),
      assetsParams(frame.id),
    );
    // Simulate the hub acking a device refusal on the queued command.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [command] = await commandsOfType(frame.id, "asset_get");
      if (command) {
        await db
          .update(frameCommands)
          .set({ error: "not_found", status: "failed" })
          .where(eq(frameCommands.id, command.id));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const response = await pending;
    expect(response.status).toBe(404);
    const payload = await response.json();
    expect(payload.error).toBe("not_found");
  }, 15_000);
});

describe("POST /api/frames/{id}/event/{event}", () => {
  it("maps uploadScenes onto a checksummed set_scenes push", async () => {
    const { frame } = await activeFrame();
    const scenes = [
      { edges: [], id: "scene1", name: "One", nodes: [] },
      { edges: [], id: "scene2", name: "Two", nodes: [] },
    ];
    const response = await postFrameEvent(
      postJson(`/api/frames/${frame.id}/event/uploadScenes`, {
        sceneId: "scene2",
        scenes,
        state: { greeting: "hey" },
      }),
      eventParams(frame.id, "uploadScenes"),
    );
    expect(response.status).toBe(200);
    const commands = await commandsOfType(frame.id, "set_scenes");
    expect(commands).toHaveLength(1);
    const payload = commands[0]!.payload as Record<string, unknown>;
    expect(payload.scenes).toEqual(scenes);
    expect(payload.scene_id).toBe("scene2");
    expect(payload.state).toEqual({ greeting: "hey" });
    expect(payload.checksum).toBe(
      createHash("sha256").update(JSON.stringify(scenes)).digest("hex"),
    );
    // Preview pushes wait for sleeping battery frames like assignment pushes.
    expect(commands[0]!.expiresAt).toBeNull();

    // A newer push supersedes the older one.
    await postFrameEvent(
      postJson(`/api/frames/${frame.id}/event/uploadScenes`, {
        scenes: [scenes[0]],
      }),
      eventParams(frame.id, "uploadScenes"),
    );
    const after = await commandsOfType(frame.id, "set_scenes");
    expect(after).toHaveLength(2);
    expect(after[0]!.status).toBe("expired");
    expect(after[0]!.error).toBe("superseded");
    expect(after[1]!.status).toBe("pending");
  });

  it("maps setCurrentScene (with state) and render onto their verbs", async () => {
    const { frame } = await activeFrame();
    const activate = await postFrameEvent(
      postJson(`/api/frames/${frame.id}/event/setCurrentScene`, {
        sceneId: "uploaded/scene9",
        state: { mood: "calm" },
      }),
      eventParams(frame.id, "setCurrentScene"),
    );
    expect(activate.status).toBe(200);
    const [sceneCommand] = await commandsOfType(frame.id, "set_current_scene");
    expect(sceneCommand!.payload).toEqual({
      scene_id: "uploaded/scene9",
      state: { mood: "calm" },
    });
    expect(sceneCommand!.expiresAt).not.toBeNull();

    const render = await postFrameEvent(
      postJson(`/api/frames/${frame.id}/event/render`, {}),
      eventParams(frame.id, "render"),
    );
    expect(render.status).toBe(200);
    expect(await commandsOfType(frame.id, "render")).toHaveLength(1);
  });

  it("refuses events without a cloud verb, bad payloads and pending frames", async () => {
    const { frame } = await activeFrame();
    const unsupported = await postFrameEvent(
      postJson(`/api/frames/${frame.id}/event/metrics`, {}),
      eventParams(frame.id, "metrics"),
    );
    expect(unsupported.status).toBe(404);

    const noScene = await postFrameEvent(
      postJson(`/api/frames/${frame.id}/event/setCurrentScene`, {}),
      eventParams(frame.id, "setCurrentScene"),
    );
    expect(noScene.status).toBe(400);

    const emptyScenes = await postFrameEvent(
      postJson(`/api/frames/${frame.id}/event/uploadScenes`, { scenes: [] }),
      eventParams(frame.id, "uploadScenes"),
    );
    expect(emptyScenes.status).toBe(400);

    const { frame: pendingFrame } = await activeFrame("pending");
    const refused = await postFrameEvent(
      postJson(`/api/frames/${pendingFrame.id}/event/render`, {}),
      eventParams(pendingFrame.id, "render"),
    );
    expect(refused.status).toBe(409);
  });
});

describe("DELETE /api/frames/{id}", () => {
  it("revokes the link, drops the row and cascades the caches", async () => {
    const { frame } = await activeFrame();
    await storeFrameAssetListing(
      db,
      frame.id,
      [{ mtime: 1, path: "a.png", size: 5 }],
      false,
    );
    await storeFrameAssetFile(db, frame.id, {
      content: Buffer.from("bytes"),
      contentType: "image/png",
      path: "a.png",
      thumb: false,
    });
    await postFrameEvent(
      postJson(`/api/frames/${frame.id}/event/render`, {}),
      eventParams(frame.id, "render"),
    );

    const request = new NextRequest(
      new URL(`/api/frames/${frame.id}`, baseUrl),
      { headers: { origin: baseUrl }, method: "DELETE" },
    );
    const response = await deleteFrame(request, assetsParams(frame.id));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("deleted");

    expect(
      await db.select().from(frames).where(eq(frames.id, frame.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(frameAssetFiles)
        .where(eq(frameAssetFiles.frameId, frame.id)),
    ).toHaveLength(0);
    expect(await commandsOfType(frame.id, "render")).toHaveLength(0);
    // The link is dead: the device's next connect gets 401 and demotes.
    const [client] = await db
      .select()
      .from(linkedClients)
      .where(eq(linkedClients.id, frame.linkedClientId));
    expect(client?.revokedAt).not.toBeNull();

    // Deleting again is an honest 404, not an error.
    const again = await deleteFrame(
      new NextRequest(new URL(`/api/frames/${frame.id}`, baseUrl), {
        headers: { origin: baseUrl },
        method: "DELETE",
      }),
      assetsParams(frame.id),
    );
    expect(again.status).toBe(404);
  });
});

describe("asset storage helpers", () => {
  it("parseAssetEntries keeps only sane wire-contract entries", () => {
    expect(
      parseAssetEntries([
        { mtime: 1, path: "ok.png", size: 10 },
        { is_dir: true, mtime: 2, path: "dir", size: 0 },
        { mtime: 3, path: "/absolute.png", size: 1 },
        { mtime: 4, path: "sneaky/../../etc", size: 1 },
        { mtime: 5, path: "", size: 1 },
        { extra: "dropped", mtime: 6, path: "clean.png", size: 2 },
        "garbage",
        null,
      ]),
    ).toEqual([
      { mtime: 1, path: "ok.png", size: 10 },
      { is_dir: true, mtime: 2, path: "dir", size: 0 },
      { mtime: 6, path: "clean.png", size: 2 },
    ]);
    expect(parseAssetEntries("nonsense")).toEqual([]);
  });

  it("storeFrameAssetFile prunes the per-frame cache LRU-style", async () => {
    const { frame } = await activeFrame();
    for (let index = 0; index < maxAssetFilesPerFrame + 5; index += 1) {
      await storeFrameAssetFile(db, frame.id, {
        content: Buffer.from(`file-${index}`),
        contentType: "text/plain",
        path: `file-${index}.txt`,
        thumb: false,
      });
    }
    const rows = await db
      .select({ path: frameAssetFiles.path })
      .from(frameAssetFiles)
      .where(eq(frameAssetFiles.frameId, frame.id));
    expect(rows).toHaveLength(maxAssetFilesPerFrame);
    // The oldest writes are the ones evicted.
    expect(rows.some((row) => row.path === "file-0.txt")).toBe(false);
    expect(rows.some((row) => row.path === "file-4.txt")).toBe(false);
    expect(rows.some((row) => row.path === "file-5.txt")).toBe(true);
  });

  it("storeFrameAssetFile evicts by bytes as well as count", async () => {
    const { frame } = await activeFrame();
    // Exactly the per-file ceiling: three fill the byte cap, the fourth must
    // evict the oldest.
    const big = Buffer.alloc(maxAssetFileBytes, 7);
    expect(maxAssetCacheBytesPerFrame).toBe(3 * maxAssetFileBytes);
    for (let index = 0; index < 4; index += 1) {
      await storeFrameAssetFile(db, frame.id, {
        content: big,
        contentType: "application/octet-stream",
        path: `big-${index}.bin`,
        thumb: false,
      });
    }
    const rows = await db
      .select({ path: frameAssetFiles.path })
      .from(frameAssetFiles)
      .where(eq(frameAssetFiles.frameId, frame.id));
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.path === "big-0.bin")).toBe(false);
  });

  it("storeFrameAssetListing refuses oversized listings", async () => {
    const { frame } = await activeFrame();
    const entries = Array.from({ length: 3000 }, (_, index) => ({
      mtime: index,
      path: `${"x".repeat(120)}/${index}.png`,
      size: index,
    }));
    expect(await storeFrameAssetListing(db, frame.id, entries, false)).toBe(
      false,
    );
    expect(
      await storeFrameAssetListing(
        db,
        frame.id,
        entries.slice(0, 10),
        true,
      ),
    ).toBe(true);
  });
});
