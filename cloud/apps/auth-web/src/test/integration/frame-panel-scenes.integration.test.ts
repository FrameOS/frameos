// The scene store on a frame's own screen (docs/scene-store-on-frame.md):
// the short store listing a frame reads with no credential, and what the
// frame asks of the cloud with its enrollment bearer (install, preview,
// update, remove, discard), each landing on the frame's command queue the
// way the workspace's buttons do, never granting a service key, and refused
// when the owner turned the settings on the screen off.
import { generateKeyPairSync } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { NextRequest } from "next/server";
import {
  createDb,
  frameCommands,
  frameSceneAssignments,
  frames,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { POST as mintClaimToken } from "../../../app/api/frames/claim-tokens/route";
import { POST as enrollFrame } from "../../../app/api/frames/enroll/route";
import { POST as confirmFrame } from "../../../app/api/frames/[frameId]/confirm/route";
import { POST as assignFrameScenes } from "../../../app/api/frames/[frameId]/scenes/route";
import { POST as panelScenes } from "../../../app/api/frames/[frameId]/panel/scenes/route";
import { GET as getScenePreview } from "../../../app/api/frames/[frameId]/scene-preview/route";
import { GET as getDeviceStore } from "../../../app/api/store/device/scenes/route";
import { GET as getDeviceStoreScene } from "../../../app/api/store/device/scenes/[sceneId]/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { storeDevicePageSize } from "../../lib/store-device";
import { createSession, sessionCookieName } from "../../lib/session";

const baseUrl = "http://localhost:3000";
const issuer = "https://accounts.google.com";
const db = createDb();
let userCounter = 0;
let sceneCounter = 0;

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

function postJson(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

const routeParams = (frameId: string) => ({ params: Promise.resolve({ frameId }) });

async function account(name: string) {
  userCounter += 1;
  const providerSubject = `panel-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: name,
    email: `panel-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  return { accountId, providerSubject };
}

async function signIn() {
  const { accountId, providerSubject } = await account(`Owner ${userCounter + 1}`);
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

function devicePublicKey() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

// A store scene with one version whose scenes.json carries `runtimeIds`.
async function storeScene(
  accountId: string,
  name: string,
  {
    category = "weather",
    description = "",
    riskFlags = [] as string[],
    runtimeIds = [`rt-${sceneCounter + 1}`],
    visibility = "public",
  } = {},
) {
  sceneCounter += 1;
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      category,
      description,
      latestVersion: 1,
      name,
      riskFlags,
      slug: `panel-scene-${sceneCounter}`,
      status: "active",
      visibility,
    })
    .returning();
  if (!scene) {
    throw new Error("scene insert failed");
  }
  await addVersion(scene.id, 1, runtimeIds, name, riskFlags);
  return { id: scene.id, runtimeIds };
}

async function addVersion(sceneId: string, version: number, runtimeIds: string[], name: string, riskFlags: string[] = []) {
  const scenes = runtimeIds.map((id) => ({ edges: [], id, name: `${name} ${id}`, nodes: [], settings: { execution: "interpreted" } }));
  await db.insert(storeSceneVersions).values({
    content: Buffer.from(zipSync({ "scene/scenes.json": new TextEncoder().encode(JSON.stringify(scenes)) })),
    contentType: "application/zip",
    riskFlags,
    sceneId,
    sha256: `panel-${sceneId}-${version}`,
    sizeBytes: 1000,
    version,
  });
  await db.update(storeScenes).set({ latestVersion: version }).where(eq(storeScenes.id, sceneId));
}

// Enroll → confirm → active: an ESP32 frame, the way a real one arrives.
async function activeFrame() {
  const accountId = await signIn();
  const mint = await mintClaimToken(postJson("/api/frames/claim-tokens", { name: "Hall" }, { origin: baseUrl }));
  expect(mint.status).toBe(200);
  const { claim_token } = (await mint.json()) as { claim_token: string };
  const enroll = await enrollFrame(
    postJson("/api/frames/enroll", {
      claim_token,
      frameos_version: "2026.11.6",
      hardware: { height: 480, platform: "esp32-s3", width: 800 },
      public_key: devicePublicKey(),
    }),
  );
  expect(enroll.status).toBe(200);
  const payload = (await enroll.json()) as { access_token: string; frame_id: string };
  const confirm = await confirmFrame(
    postJson(`/api/frames/${payload.frame_id}/confirm`, {}, { origin: baseUrl }),
    routeParams(payload.frame_id),
  );
  expect(confirm.status).toBe(200);
  return { accountId, ...payload };
}

async function assignScenes(frameId: string, sceneIds: string[]) {
  const response = await assignFrameScenes(
    postJson(`/api/frames/${frameId}/scenes`, { scenes: sceneIds.map((scene_id) => ({ scene_id })) }, { origin: baseUrl }),
    routeParams(frameId),
  );
  expect(response.status).toBe(200);
  await db.delete(frameCommands).where(eq(frameCommands.frameId, frameId));
}

function panel(frameId: string, token: string, body: Record<string, unknown>) {
  return panelScenes(
    postJson(`/api/frames/${frameId}/panel/scenes`, body, { authorization: `Bearer ${token}` }),
    routeParams(frameId),
  );
}

async function assignedIds(frameId: string) {
  const rows = await db
    .select({ sceneId: frameSceneAssignments.sceneId, settingsGroups: frameSceneAssignments.grantedSettingsGroups })
    .from(frameSceneAssignments)
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(frameSceneAssignments.position);
  return rows;
}

async function newestPush(frameId: string) {
  const [row] = await db
    .select({ payload: frameCommands.payload, status: frameCommands.status })
    .from(frameCommands)
    .where(and(eq(frameCommands.frameId, frameId), eq(frameCommands.type, "set_scenes")))
    .orderBy(desc(frameCommands.createdAt), desc(frameCommands.id))
    .limit(1);
  return row?.payload as
    | { preview?: Record<string, unknown>; scene_id?: string; scenes: { id: string; origin?: { storeSceneId?: string } }[] }
    | undefined;
}

function get(path: string) {
  return new NextRequest(new URL(path, baseUrl), { method: "GET" });
}

describe("GET /api/store/device/scenes", () => {
  it("lists what a frame is offered, a dozen short entries a page", async () => {
    const { accountId } = await account("Publisher");
    const listed: string[] = [];
    for (let i = 0; i < storeDevicePageSize + 2; i += 1) {
      listed.push((await storeScene(accountId, `Weather ${i}`, { description: "x".repeat(400) })).id);
    }
    await storeScene(accountId, "Private one", { visibility: "private" });
    await storeScene(accountId, "Unfiled one", { category: null as unknown as string });
    await storeScene(accountId, "Shell one", { riskFlags: ["shell"] });

    const first = await getDeviceStore(get("/api/store/device/scenes?categories=1"));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    // The browser preview runs the store scene too.
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    const page1 = (await first.json()) as {
      categories: { slug: string; title: string }[];
      more: boolean;
      page: number;
      scenes: Record<string, unknown>[];
    };
    expect(page1.page).toBe(1);
    expect(page1.more).toBe(true);
    expect(page1.scenes).toHaveLength(storeDevicePageSize);
    // Short keys, nothing a frame does not draw.
    expect(Object.keys(page1.scenes[0]!).sort()).toEqual([
      "about",
      "by",
      "category",
      "id",
      "image",
      "name",
      "thumb",
      "version",
    ]);
    // No cover here, and no CDN in this test to hand a cover's copy from.
    expect(page1.scenes[0]).toMatchObject({ by: "Publisher", category: "weather", image: null, thumb: null, version: 1 });
    // A line or two of the description for a card.
    expect(Array.from(page1.scenes[0]!.about as string).length).toBeLessThanOrEqual(140);
    expect(page1.categories.find((category) => category.slug === "weather")).toEqual({
      slug: "weather",
      title: "Weather",
    });

    const second = (await (await getDeviceStore(get("/api/store/device/scenes?page=2"))).json()) as {
      categories?: unknown;
      more: boolean;
      scenes: { id: string; name: string }[];
    };
    expect(second.more).toBe(false);
    expect(second.categories).toBeUndefined();
    const all = [...page1.scenes.map((scene) => scene.id as string), ...second.scenes.map((scene) => scene.id)];
    expect(all.sort()).toEqual([...listed].sort());

    const searched = (await (await getDeviceStore(get("/api/store/device/scenes?q=weather%2013"))).json()) as {
      scenes: { name: string }[];
    };
    expect(searched.scenes.map((scene) => scene.name)).toEqual(["Weather 13"]);
    const shelf = (await (await getDeviceStore(get("/api/store/device/scenes?category=photos"))).json()) as {
      scenes: unknown[];
    };
    expect(shelf.scenes).toEqual([]);
  });

  it("takes the page size of the frame's grid, a shelf to put first and shelves to leave out", async () => {
    const { accountId } = await account("Publisher");
    for (let i = 0; i < 4; i += 1) {
      await storeScene(accountId, `Weather ${i}`);
    }
    const movers = [await storeScene(accountId, "Bounce", { category: "realtime" }), await storeScene(accountId, "Spin", { category: "realtime" })];
    const read = async (query: string) =>
      (await (await getDeviceStore(get(`/api/store/device/scenes?${query}`))).json()) as {
        more: boolean;
        scenes: { category: string; id: string }[];
      };

    const small = await read("limit=3");
    expect(small.scenes).toHaveLength(3);
    expect(small.more).toBe(true);
    const third = await read("limit=3&page=2");
    expect(third.scenes).toHaveLength(3);
    expect(third.more).toBe(false);
    // Out of range: held to 1..24.
    expect((await read("limit=0")).scenes).toHaveLength(1);

    // A fast panel's real time shelf first.
    const fast = await read("prefer=realtime");
    expect(fast.scenes.slice(0, 2).map((scene) => scene.id).sort()).toEqual(movers.map((scene) => scene.id).sort());
    // E-paper leaves it out; a slug the store does not know is no filter.
    const paper = await read("exclude=realtime,nonsense");
    expect(paper.scenes.map((scene) => scene.category)).toEqual(["weather", "weather", "weather", "weather"]);
    expect((await read("prefer=nonsense")).scenes).toHaveLength(6);
  });

  it("answers one listed scene with its newest version and a short description", async () => {
    const { accountId } = await account("Publisher");
    const scene = await storeScene(accountId, "Rain radar", { description: "word ".repeat(100) });
    await addVersion(scene.id, 2, scene.runtimeIds, "Rain radar");
    const response = await getDeviceStoreScene(get(`/api/store/device/scenes/${scene.id}`), {
      params: Promise.resolve({ sceneId: scene.id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { description: string; name: string; version: number };
    expect(body).toMatchObject({ by: "Publisher", category: "weather", id: scene.id, name: "Rain radar", version: 2 });
    expect(Array.from(body.description).length).toBeLessThanOrEqual(280);
    expect(body.description.endsWith("…")).toBe(true);

    const hidden = await storeScene(accountId, "Mine alone", { visibility: "private" });
    const missing = await getDeviceStoreScene(get(`/api/store/device/scenes/${hidden.id}`), {
      params: Promise.resolve({ sceneId: hidden.id }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/frames/{id}/panel/scenes", () => {
  it("installs a public store scene, shows it, and grants it nothing", async () => {
    const frame = await activeFrame();
    const own = await storeScene(frame.accountId, "Clock", { visibility: "private" });
    await assignScenes(frame.frame_id, [own.id]);
    const { accountId: publisherId } = await account("Publisher");
    const radar = await storeScene(publisherId, "Rain radar", { runtimeIds: ["radar-rt"] });

    const response = await panel(frame.frame_id, frame.access_token, { action: "install", scene_id: radar.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ needs_settings_groups: [], ok: true, status: "queued", version: 1 });
    const assigned = await assignedIds(frame.frame_id);
    expect(assigned.map((row) => row.sceneId)).toEqual([own.id, radar.id]);
    expect(assigned[1]!.settingsGroups ?? []).toEqual([]);
    const push = await newestPush(frame.frame_id);
    expect(push?.scene_id).toBe("radar-rt");
    expect(push?.scenes.map((scene) => scene.id)).toEqual([own.runtimeIds[0], "radar-rt"]);
  });

  it("installs without switching to it when the store asks to stay", async () => {
    const frame = await activeFrame();
    const own = await storeScene(frame.accountId, "Scene store", { visibility: "private", runtimeIds: ["store-rt"] });
    await assignScenes(frame.frame_id, [own.id]);
    const { accountId: publisherId } = await account("Publisher");
    const radar = await storeScene(publisherId, "Rain radar", { runtimeIds: ["radar-rt"] });

    const response = await panel(frame.frame_id, frame.access_token, { action: "install", scene_id: radar.id, show: false });
    expect(response.status).toBe(200);
    expect((await assignedIds(frame.frame_id)).map((row) => row.sceneId)).toEqual([own.id, radar.id]);
    const push = await newestPush(frame.frame_id);
    expect(push?.scenes.map((scene) => scene.id)).toEqual(["store-rt", "radar-rt"]);
    expect(push?.scene_id).not.toBe("radar-rt");

    // Installed already and asked to stay: nothing to send.
    await db.delete(frameCommands).where(eq(frameCommands.frameId, frame.frame_id));
    const again = await panel(frame.frame_id, frame.access_token, { action: "install", scene_id: radar.id, show: false });
    expect(await again.json()).toEqual({ already_assigned: true, ok: true, status: "up_to_date" });
    expect(await newestPush(frame.frame_id)).toBeUndefined();
  });

  it("refuses what a frame may not ask", async () => {
    // Another account's frame first: the session that stays is the owner's.
    const other = await activeFrame();
    const frame = await activeFrame();
    const own = await storeScene(frame.accountId, "Clock", { visibility: "private" });
    await assignScenes(frame.frame_id, [own.id]);
    const { accountId: publisherId } = await account("Publisher");
    const hidden = await storeScene(publisherId, "Hidden", { visibility: "private" });
    const radar = await storeScene(publisherId, "Rain radar");

    // Another frame's token, no token, a made-up action, a private scene.
    expect((await panel(frame.frame_id, other.access_token, { action: "install", scene_id: radar.id })).status).toBe(403);
    expect((await panel(frame.frame_id, "nope", { action: "install", scene_id: radar.id })).status).toBe(401);
    expect((await panel(frame.frame_id, frame.access_token, { action: "publish", scene_id: radar.id })).status).toBe(400);
    expect((await panel(frame.frame_id, frame.access_token, { action: "install", scene_id: hidden.id })).status).toBe(404);
    // The owner's own private scene: never through the frame's token either.
    const ownSecond = await storeScene(frame.accountId, "Diary", { visibility: "private" });
    expect((await panel(frame.frame_id, frame.access_token, { action: "preview", scene_id: ownSecond.id })).status).toBe(404);
    // The last scene stays.
    const last = await panel(frame.frame_id, frame.access_token, { action: "remove", scene_id: own.id });
    expect(last.status).toBe(409);
    expect(await last.json()).toMatchObject({ error: "last_scene" });

    // The settings on the screen turned off: nothing at all.
    await db.update(frames).set({ settings: { frame_settings_on_screen: false } }).where(eq(frames.id, frame.frame_id));
    const locked = await panel(frame.frame_id, frame.access_token, { action: "install", scene_id: radar.id });
    expect(locked.status).toBe(403);
    expect(await locked.json()).toMatchObject({ error: "panel_locked" });
    expect((await assignedIds(frame.frame_id)).map((row) => row.sceneId)).toEqual([own.id]);
  });

  it("updates an installed scene to its newest version, then says it is up to date", async () => {
    const frame = await activeFrame();
    const { accountId: publisherId } = await account("Publisher");
    const radar = await storeScene(publisherId, "Rain radar", { runtimeIds: ["radar-rt"] });
    await assignScenes(frame.frame_id, [radar.id]);
    await addVersion(radar.id, 2, ["radar-rt"], "Rain radar");

    const updated = await panel(frame.frame_id, frame.access_token, { action: "update", scene_id: radar.id });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ ok: true, status: "queued", version: 2 });
    const push = await newestPush(frame.frame_id);
    expect(push?.scenes[0]?.origin).toMatchObject({ storeSceneId: radar.id, version: "2" });

    const again = await panel(frame.frame_id, frame.access_token, { action: "update", scene_id: radar.id });
    expect(await again.json()).toMatchObject({ ok: true, status: "up_to_date" });
  });

  it("removes one installed scene and pushes the rest", async () => {
    const frame = await activeFrame();
    const clock = await storeScene(frame.accountId, "Clock", { visibility: "private" });
    const { accountId: publisherId } = await account("Publisher");
    const radar = await storeScene(publisherId, "Rain radar", { runtimeIds: ["radar-rt"] });
    await assignScenes(frame.frame_id, [clock.id, radar.id]);

    const removed = await panel(frame.frame_id, frame.access_token, { action: "remove", scene_id: radar.id });
    expect(removed.status).toBe(200);
    expect((await assignedIds(frame.frame_id)).map((row) => row.sceneId)).toEqual([clock.id]);
    expect((await newestPush(frame.frame_id))?.scenes.map((scene) => scene.id)).toEqual([clock.runtimeIds[0]]);
    // Not installed (any more): nothing to update or remove.
    expect((await panel(frame.frame_id, frame.access_token, { action: "update", scene_id: radar.id })).status).toBe(404);
  });

  it("previews a store scene beside the frame's list, then discards it", async () => {
    const frame = await activeFrame();
    const clock = await storeScene(frame.accountId, "Clock", { visibility: "private" });
    await assignScenes(frame.frame_id, [clock.id]);
    const { accountId: publisherId } = await account("Publisher");
    const split = await storeScene(publisherId, "Split", { runtimeIds: ["split-rt", "left-rt"] });

    const previewed = await panel(frame.frame_id, frame.access_token, { action: "preview", scene_id: split.id });
    expect(previewed.status).toBe(200);
    expect(await previewed.json()).toMatchObject({ ok: true, scene_id: "split-rt", status: "queued" });
    const push = await newestPush(frame.frame_id);
    // The list stays, the scene and its panel come beside it, and it shows.
    expect(push?.scenes.map((scene) => scene.id)).toEqual([clock.runtimeIds[0], "split-rt", "left-rt"]);
    expect(push?.scene_id).toBe("split-rt");
    expect(push?.preview).toMatchObject({ name: "Split", scene_id: "split-rt", source: "panel" });
    // A preview is not an install.
    expect((await assignedIds(frame.frame_id)).map((row) => row.sceneId)).toEqual([clock.id]);
    const info = await getScenePreview(get(`/api/frames/${frame.frame_id}/scene-preview`), routeParams(frame.frame_id));
    expect(await info.json()).toMatchObject({ preview: { name: "Split", scene_id: "split-rt", source: "panel" } });

    // Installed already: Show it, not a preview.
    expect((await panel(frame.frame_id, frame.access_token, { action: "preview", scene_id: clock.id })).status).toBe(409);

    const discarded = await panel(frame.frame_id, frame.access_token, { action: "discard", scene_id: clock.runtimeIds[0] });
    expect(discarded.status).toBe(200);
    const back = await newestPush(frame.frame_id);
    expect(back?.scenes.map((scene) => scene.id)).toEqual([clock.runtimeIds[0]]);
    expect(back?.scene_id).toBe(clock.runtimeIds[0]);
    expect(back?.preview).toBeUndefined();
  });
});
