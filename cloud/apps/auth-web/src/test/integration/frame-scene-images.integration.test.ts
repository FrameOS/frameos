// GET /api/frames/{id}/scene_images/{sceneId} — cloud-workspace-gaps.md
// item 2, short-term shape: the store scene's cover stands in for a per-scene
// preview. The SPA asks with the RUNTIME scene id from the installed zip's
// scenes.json, so the route must map runtime id → owning store scene via the
// frame's assignments; the raw store uuid must also work.
import { generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { zipSync, zlibSync } from "fflate";
import { NextRequest } from "next/server";
import {
  createDb,
  frameAssetFiles,
  frameCommands,
  frames,
  frameSceneAssignments,
  linkedClients,
  storeSceneImages,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getSceneImage } from "../../../app/api/frames/[frameId]/scene_images/[sceneId]/route";
import { POST as assignFrameScenes } from "../../../app/api/frames/[frameId]/scenes/route";
import { readBlob } from "../../lib/blobs";
import { sceneSnapshotAssetPath } from "../../lib/frame-asset-cache";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { resetSceneImageCacheForTests } from "../../lib/scene-images";
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
  resetSceneImageCacheForTests();
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

const routeParams = (frameId: string, sceneId: string) => ({
  params: Promise.resolve({ frameId, sceneId }),
});

async function signIn() {
  userCounter += 1;
  const providerSubject = `scene-image-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Scene Image User ${userCounter}`,
    email: `scene-images-${userCounter}@example.com`,
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

async function activeFrame(accountId: string) {
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: "Scene image frame",
      tokenReference: hashSecret(`fc_link_scene_images_${accountId}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: client!.id,
      name: "Scene image frame",
      publicKey: rawPublicKeyBase64(),
      status: "active",
    })
    .returning();
  return frame!;
}

// The published zip carries the RUNTIME scene ids in scenes.json — the ids
// the SPA's hydrated tiles use — while the store row keeps its own uuid.
function sceneZip(runtimeSceneIds: string[]) {
  const scenes = runtimeSceneIds.map((id) => ({
    edges: [],
    id,
    name: `Scene ${id}`,
    nodes: [],
  }));
  return Buffer.from(
    zipSync({
      "scene/scenes.json": new TextEncoder().encode(JSON.stringify(scenes)),
      "scene/template.json": new TextEncoder().encode(
        JSON.stringify({ name: "Test scene" }),
      ),
    }),
  );
}

async function createStoreScene(
  accountId: string,
  options: {
    name: string;
    runtimeSceneIds: string[];
    previewImage?: Buffer;
    previewImageType?: string;
  },
) {
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      latestVersion: 1,
      name: options.name,
      previewImage: options.previewImage,
      previewImageType: options.previewImageType,
      slug: `${options.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${userCounter}`,
      status: "active",
      visibility: "private",
    })
    .returning();
  if (!scene) {
    throw new Error("scene insert failed");
  }
  await db.insert(storeSceneVersions).values({
    content: sceneZip(options.runtimeSceneIds),
    contentType: "application/zip",
    sceneId: scene.id,
    sha256: "test",
    sizeBytes: 1000,
    version: 1,
  });
  return scene;
}

async function assignScene(frameId: string, sceneId: string, position = 0) {
  await db.insert(frameSceneAssignments).values({
    frameId,
    position,
    sceneId,
  });
}

// A structurally valid 8-bit RGBA PNG whose every alpha byte is zero — the
// broken live-preview screenshot legacy rows can still hold. Chunk CRCs stay
// zeroed: the transparency detector proves via pixel data, not checksums.
function transparentPng(width = 4, height = 4) {
  const raw = new Uint8Array(height * (1 + width * 4)); // filter 0, all zero
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) {
      out[4 + i] = type.charCodeAt(i);
    }
    out.set(data, 8);
    return Buffer.from(out);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

describe("GET /api/frames/{id}/scene_images/{sceneId}", () => {
  it("resolves a runtime scene id to the store scene's gallery cover", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Clock",
      previewImage: Buffer.from("preview-bytes"),
      previewImageType: "image/jpeg",
      runtimeSceneIds: ["runtime-clock", "runtime-clock-alt"],
    });
    // Two gallery rows out of order: the lowest position must win over both
    // the later row and the previewImage fallback.
    await db.insert(storeSceneImages).values([
      {
        content: Buffer.from("second-gallery"),
        contentType: "image/webp",
        position: 2,
        sceneId: scene.id,
      },
      {
        content: Buffer.from("first-gallery"),
        contentType: "image/png",
        position: 1,
        sceneId: scene.id,
      },
    ]);
    await assignScene(frame.id, scene.id);

    for (const runtimeId of ["runtime-clock", "runtime-clock-alt"]) {
      const response = await getSceneImage(
        getRequest(`/api/frames/${frame.id}/scene_images/${runtimeId}`),
        routeParams(frame.id, runtimeId),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe(
        "private, max-age=300",
      );
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
        "first-gallery",
      );
    }
  });

  it("accepts the store scene uuid directly", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Weather",
      runtimeSceneIds: ["runtime-weather"],
    });
    await db.insert(storeSceneImages).values({
      content: Buffer.from("gallery-bytes"),
      contentType: "image/png",
      position: 0,
      sceneId: scene.id,
    });
    await assignScene(frame.id, scene.id);

    const response = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/${scene.id}`),
      routeParams(frame.id, scene.id),
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "gallery-bytes",
    );
  });

  it("falls back to the store scene's previewImage when no gallery rows exist", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Gallery-less",
      previewImage: Buffer.from("preview-bytes"),
      previewImageType: "image/webp",
      runtimeSceneIds: ["runtime-plain"],
    });
    await assignScene(frame.id, scene.id);

    const response = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-plain`),
      routeParams(frame.id, "runtime-plain"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "preview-bytes",
    );
  });

  it("skips a fully transparent gallery lead and serves the next image", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Transparent lead",
      previewImage: Buffer.from("preview-bytes"),
      previewImageType: "image/webp",
      runtimeSceneIds: ["runtime-skip"],
    });
    await db.insert(storeSceneImages).values([
      {
        content: transparentPng(),
        contentType: "image/png",
        position: 1,
        sceneId: scene.id,
      },
      {
        content: Buffer.from("second-gallery"),
        contentType: "image/jpeg",
        position: 2,
        sceneId: scene.id,
      },
    ]);
    await assignScene(frame.id, scene.id);

    const response = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-skip`),
      routeParams(frame.id, "runtime-skip"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "second-gallery",
    );
  });

  it("falls to preview_image when every gallery row is transparent, and 404s when the preview is transparent too", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Only transparent gallery",
      previewImage: Buffer.from("preview-bytes"),
      previewImageType: "image/webp",
      runtimeSceneIds: ["runtime-fall"],
    });
    await db.insert(storeSceneImages).values({
      content: transparentPng(),
      contentType: "image/png",
      position: 1,
      sceneId: scene.id,
    });
    await assignScene(frame.id, scene.id);

    const fell = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-fall`),
      routeParams(frame.id, "runtime-fall"),
    );
    expect(fell.status).toBe(200);
    expect(fell.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await fell.arrayBuffer()).toString()).toBe(
      "preview-bytes",
    );

    // A legacy transparent preview_image is no better than no image.
    const blankScene = await createStoreScene(accountId, {
      name: "Transparent preview",
      previewImage: transparentPng(),
      previewImageType: "image/png",
      runtimeSceneIds: ["runtime-blank"],
    });
    await assignScene(frame.id, blankScene.id, 1);

    const blank = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-blank`),
      routeParams(frame.id, "runtime-blank"),
    );
    expect(blank.status).toBe(404);
    expect((await blank.json()).error).toBe("no_image");
  });

  it("404s for scene ids no assignment owns, and for scenes with no image at all", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Imageless",
      runtimeSceneIds: ["runtime-bare"],
    });
    await assignScene(frame.id, scene.id);

    // Unknown runtime id: resolvable frame, nothing assigned matches.
    const unknown = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-nope`),
      routeParams(frame.id, "runtime-nope"),
    );
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("no_image");

    // Known runtime id, but the scene has neither gallery rows nor preview.
    const bare = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-bare`),
      routeParams(frame.id, "runtime-bare"),
    );
    expect(bare.status).toBe(404);
    expect((await bare.json()).error).toBe("no_image");
  });

  it("404s on another account's frame without leaking whether it exists", async () => {
    const ownerId = await signIn();
    const frame = await activeFrame(ownerId);
    const scene = await createStoreScene(ownerId, {
      name: "Private",
      previewImage: Buffer.from("secret-bytes"),
      previewImageType: "image/png",
      runtimeSceneIds: ["runtime-private"],
    });
    await assignScene(frame.id, scene.id);

    // Second signIn swaps the session cookie to a different account.
    await signIn();
    const response = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-private`),
      routeParams(frame.id, "runtime-private"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("invalid_frame");
  });

  it("serves repeat requests from the cached runtime-id mapping", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Cached",
      previewImage: Buffer.from("cached-bytes"),
      previewImageType: "image/png",
      runtimeSceneIds: ["runtime-cached"],
    });
    await assignScene(frame.id, scene.id);

    const first = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-cached`),
      routeParams(frame.id, "runtime-cached"),
    );
    expect(first.status).toBe(200);

    // Corrupt the stored zip: a second lookup must ride the module-scope
    // (sceneId, version) cache instead of re-unzipping the bytes.
    await db
      .update(storeSceneVersions)
      .set({ content: Buffer.from("not a zip") })
      .where(eq(storeSceneVersions.sceneId, scene.id));

    const second = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-cached`),
      routeParams(frame.id, "runtime-cached"),
    );
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer()).toString()).toBe(
      "cached-bytes",
    );
  });

  it("prefers the device's cached snapshot over the store cover", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Snapshotted",
      previewImage: Buffer.from("cover-bytes"),
      previewImageType: "image/jpeg",
      runtimeSceneIds: ["runtime-snap"],
    });
    await assignScene(frame.id, scene.id);
    await db.insert(frameAssetFiles).values({
      content: Buffer.from("device-render"),
      contentType: "image/png",
      frameId: frame.id,
      path: sceneSnapshotAssetPath("runtime-snap"),
      sizeBytes: "device-render".length,
      thumb: false,
    });

    const response = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-snap`),
      routeParams(frame.id, "runtime-snap"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "device-render",
    );
  });

  it("queues an asset_get for the snapshot and serves the cover meanwhile", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Fetching",
      previewImage: Buffer.from("cover-bytes"),
      previewImageType: "image/jpeg",
      runtimeSceneIds: ["runtime-fetch"],
    });
    await assignScene(frame.id, scene.id);

    const response = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-fetch?thumb=1`),
      routeParams(frame.id, "runtime-fetch"),
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "cover-bytes",
    );
    const queued = await db
      .select({ payload: frameCommands.payload, type: frameCommands.type })
      .from(frameCommands)
      .where(eq(frameCommands.frameId, frame.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.type).toBe("asset_get");
    expect(queued[0]!.payload).toEqual({
      path: sceneSnapshotAssetPath("runtime-fetch"),
      thumb: true,
    });
  });

  it("404s fast for an unmapped scene on a disconnected frame, still queueing the fetch", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);

    const started = Date.now();
    const response = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-unknown`),
      routeParams(frame.id, "runtime-unknown"),
    );
    expect(response.status).toBe(404);
    // No long poll: the frame is not connected, so waiting cannot help.
    expect(Date.now() - started).toBeLessThan(5000);
    const queued = await db
      .select({ type: frameCommands.type })
      .from(frameCommands)
      .where(eq(frameCommands.frameId, frame.id));
    expect(queued.map((row) => row.type)).toEqual(["asset_get"]);
  });
});

// The explicit install-time cover copy: POST /scenes writes each installed
// scene's cover into frame_asset_files under the runtime scene ids, so a
// tile has bytes to show before the device has ever rendered the scene.
describe("POST /api/frames/{id}/scenes cover copy", () => {
  function postScenes(frameId: string, sceneIds: string[]) {
    return assignFrameScenes(
      new NextRequest(new URL(`/api/frames/${frameId}/scenes`, baseUrl), {
        body: JSON.stringify({
          scenes: sceneIds.map((id) => ({ scene_id: id })),
        }),
        headers: { "content-type": "application/json", origin: baseUrl },
        method: "POST",
      }),
      { params: Promise.resolve({ frameId }) },
    );
  }

  async function assetRows(frameId: string) {
    return await db
      .select({
        content: frameAssetFiles.content,
        contentType: frameAssetFiles.contentType,
        objectKey: frameAssetFiles.objectKey,
        path: frameAssetFiles.path,
        thumb: frameAssetFiles.thumb,
      })
      .from(frameAssetFiles)
      .where(eq(frameAssetFiles.frameId, frameId));
  }

  // Rows written since migration 0032 keep their bytes in the object store;
  // rows seeded by these tests with a literal `content` still hold them in
  // Postgres. Both are legal, and readBlob is what production reads with.
  async function assetBytes(row: {
    content: Buffer | null;
    objectKey: string | null;
  }) {
    return (await readBlob(row))?.toString();
  }

  it("copies the cover under every runtime scene id, full and thumb", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Installed",
      previewImage: Buffer.from("cover-bytes"),
      previewImageType: "image/jpeg",
      runtimeSceneIds: ["runtime-a", "runtime-b"],
    });

    const response = await postScenes(frame.id, [scene.id]);
    expect(response.status).toBe(200);

    const rows = await assetRows(frame.id);
    const expected = ["runtime-a", "runtime-b"].flatMap((id) =>
      [false, true].map((thumb) => ({
        path: sceneSnapshotAssetPath(id),
        thumb,
      })),
    );
    expect(
      rows
        .map((row) => ({ path: row.path, thumb: row.thumb }))
        .sort((a, b) =>
          `${a.path}:${a.thumb}`.localeCompare(`${b.path}:${b.thumb}`),
        ),
    ).toEqual(
      expected.sort((a, b) =>
        `${a.path}:${a.thumb}`.localeCompare(`${b.path}:${b.thumb}`),
      ),
    );
    for (const row of rows) {
      expect(await assetBytes(row)).toBe("cover-bytes");
      expect(row.contentType).toBe("image/jpeg");
    }

    // And the tile route serves the copy from the snapshot tier at once.
    const tile = await getSceneImage(
      getRequest(`/api/frames/${frame.id}/scene_images/runtime-a?thumb=1`),
      routeParams(frame.id, "runtime-a"),
    );
    expect(tile.status).toBe(200);
    expect(tile.headers.get("cache-control")).toBe("private, max-age=60");
    expect(Buffer.from(await tile.arrayBuffer()).toString()).toBe(
      "cover-bytes",
    );
  });

  it("never overwrites an existing device snapshot", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Rendered before",
      previewImage: Buffer.from("cover-bytes"),
      previewImageType: "image/jpeg",
      runtimeSceneIds: ["runtime-snapped"],
    });
    await db.insert(frameAssetFiles).values({
      content: Buffer.from("device-render"),
      contentType: "image/png",
      frameId: frame.id,
      path: sceneSnapshotAssetPath("runtime-snapped"),
      sizeBytes: "device-render".length,
      thumb: false,
    });

    const response = await postScenes(frame.id, [scene.id]);
    expect(response.status).toBe(200);

    const rows = await assetRows(frame.id);
    const full = rows.find((row) => !row.thumb);
    const thumb = rows.find((row) => row.thumb);
    // The device's render survives; only the missing thumb slot is filled.
    expect(await assetBytes(full!)).toBe("device-render");
    expect(await assetBytes(thumb!)).toBe("cover-bytes");
  });

  it("copies nothing for a scene with no cover, without failing the push", async () => {
    const accountId = await signIn();
    const frame = await activeFrame(accountId);
    const scene = await createStoreScene(accountId, {
      name: "Coverless",
      runtimeSceneIds: ["runtime-bare-install"],
    });

    const response = await postScenes(frame.id, [scene.id]);
    expect(response.status).toBe(200);
    expect(await assetRows(frame.id)).toEqual([]);
  });
});
