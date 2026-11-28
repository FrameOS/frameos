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
    isLayout = false,
    needs = [] as string[],
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
      needs,
      riskFlags,
      slug: `panel-scene-${sceneCounter}`,
      status: "active",
      visibility,
    })
    .returning();
  if (!scene) {
    throw new Error("scene insert failed");
  }
  await addVersion(scene.id, 1, runtimeIds, name, riskFlags, isLayout);
  return { id: scene.id, runtimeIds };
}

async function addVersion(
  sceneId: string,
  version: number,
  runtimeIds: string[],
  name: string,
  riskFlags: string[] = [],
  isLayout = false,
  extra: Record<string, unknown> = {},
) {
  const scenes = runtimeIds.map((id) => ({
    edges: [],
    id,
    name: `${name} ${id}`,
    nodes: [],
    settings: { execution: "interpreted", ...(isLayout ? { isLayout: true } : {}) },
    ...extra,
  }));
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
    expect(page1.categories.find((category) => category.slug === "video")).toEqual({ slug: "video", title: "Video" });
    // An ESP32 plays no video: its store has no Video shelf, which would always be empty.
    const esp32 = (await (await getDeviceStore(get("/api/store/device/scenes?categories=1&without=linux,video"))).json()) as {
      categories: { slug: string }[];
    };
    expect(esp32.categories.map((category) => category.slug)).toEqual(
      page1.categories.map((category) => category.slug).filter((slug) => slug !== "video"),
    );

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

  it("gives Featured as one page: what was featured, then each shelf's best by turns", async () => {
    const { accountId } = await account("Publisher");
    const scene = async (name: string, category: string, downloads: number, needs: string[] = []) => {
      const made = await storeScene(accountId, name, { category, needs });
      await db.update(storeScenes).set({ downloadCount: downloads }).where(eq(storeScenes.id, made.id));
      return made.id;
    };
    const weather = [await scene("Weather 1", "weather", 50), await scene("Weather 2", "weather", 40), await scene("Weather 3", "weather", 30)];
    const photos = [await scene("Photos 1", "photos", 5), await scene("Photos 2", "photos", 4)];
    const clock = await scene("Clock", "clocks", 1);
    const demo = await scene("Demo", "demos", 1000);
    const picked = await scene("Picked", "weather", 0);
    await db.update(storeScenes).set({ featuredAt: new Date() }).where(eq(storeScenes.id, picked));
    const read = async (query: string) =>
      (await (await getDeviceStore(get(`/api/store/device/scenes?${query}`))).json()) as {
        more: boolean;
        scenes: { id: string }[];
      };
    const ids = async (query: string) => (await read(query)).scenes.map((row) => row.id);

    // What was featured, then every shelf's first in the store front's order
    // (Photos, Clocks, Weather), then every shelf's second, and so on.
    const featured = await read("featured=1&exclude=demos");
    expect(featured.more).toBe(false);
    expect(featured.scenes.map((row) => row.id)).toEqual([picked, photos[0], clock, weather[0], photos[1], weather[1], weather[2]]);
    // One page: none after it, and a smaller page is cut where it ends.
    expect(await ids("featured=1&exclude=demos&page=2")).toEqual([]);
    expect(await ids("featured=1&exclude=demos&limit=3")).toEqual([picked, photos[0], clock]);
    // A shelf left out is, however much it was downloaded.
    expect(await ids("featured=1")).toContain(demo);
    // A fast panel gets a shelf's fast scenes first.
    const mover = await scene("Mover", "weather", 0, ["fast"]);
    expect((await ids("featured=1&exclude=demos&prefer=fast")).slice(0, 4)).toEqual([picked, photos[0], clock, mover]);
    // A shelf or a search is not Featured.
    expect(await ids("featured=1&category=photos")).toEqual(photos);
    expect(await ids("featured=1&q=Clock")).toEqual([clock]);
    // Without it, every scene, as an app from before asks.
    const everything = await read("limit=24");
    expect(everything.scenes).toHaveLength(9);
  });

  it("takes the page size of the frame's grid, what to put first and what it cannot run", async () => {
    const { accountId } = await account("Publisher");
    for (let i = 0; i < 4; i += 1) {
      await storeScene(accountId, `Weather ${i}`);
    }
    const movers = [
      await storeScene(accountId, "Bounce", { category: "fun", needs: ["fast"] }),
      await storeScene(accountId, "Spin", { category: "games", needs: ["fast", "touch"] }),
    ];
    const read = async (query: string) =>
      (await (await getDeviceStore(get(`/api/store/device/scenes?${query}`))).json()) as {
        more: boolean;
        scenes: { category: string; id: string; needs?: string[] }[];
      };

    const small = await read("limit=3");
    expect(small.scenes).toHaveLength(3);
    expect(small.more).toBe(true);
    const third = await read("limit=3&page=2");
    expect(third.scenes).toHaveLength(3);
    expect(third.more).toBe(false);
    // Out of range: held to 1..24.
    expect((await read("limit=0")).scenes).toHaveLength(1);

    // A fast panel gets the scenes made for it first, each saying what it needs.
    const fast = await read("prefer=fast");
    expect(fast.scenes.slice(0, 2).map((scene) => scene.id).sort()).toEqual(movers.map((scene) => scene.id).sort());
    expect(fast.scenes.find((scene) => scene.id === movers[1]!.id)?.needs).toEqual(["fast", "touch"]);
    expect(fast.scenes.find((scene) => scene.category === "weather")?.needs).toBeUndefined();
    // E-paper is not offered them; a need or slug the store does not know is no filter.
    const paper = await read("without=fast,nonsense");
    expect(paper.scenes.map((scene) => scene.category)).toEqual(["weather", "weather", "weather", "weather"]);
    expect((await read("prefer=nonsense")).scenes).toHaveLength(6);
    // The app before needs asked for the Real time shelf by name: the same scenes.
    const before = await read("prefer=realtime");
    expect(before.scenes.slice(0, 2).map((scene) => scene.id).sort()).toEqual(movers.map((scene) => scene.id).sort());
    expect((await read("exclude=realtime")).scenes.map((scene) => scene.category)).toEqual([
      "weather",
      "weather",
      "weather",
      "weather",
    ]);
    // A shelf left out by name still is.
    expect((await read("exclude=games")).scenes).toHaveLength(5);
  });

  it("puts the scenes made for a round screen first on a round panel, the first need asked weighing most", async () => {
    const { accountId } = await account("Publisher");
    for (let i = 0; i < 3; i += 1) {
      await storeScene(accountId, `Weather ${i}`);
    }
    const dial = await storeScene(accountId, "Dial", { category: "clocks", needs: ["round"] });
    const spin = await storeScene(accountId, "Spin", { category: "games", needs: ["fast"] });
    const both = await storeScene(accountId, "Orbit", { category: "fun", needs: ["fast", "round"] });
    const read = async (query: string) =>
      (await (await getDeviceStore(get(`/api/store/device/scenes?${query}`))).json()) as {
        scenes: { id: string; needs?: string[] }[];
      };

    const round = await read("prefer=round");
    expect(round.scenes.slice(0, 2).map((scene) => scene.id).sort()).toEqual([dial.id, both.id].sort());
    expect(round.scenes.find((scene) => scene.id === dial.id)?.needs).toEqual(["round"]);
    // A round LCD: round first, then fast among them and after them.
    const roundFast = await read("prefer=round,fast");
    expect(roundFast.scenes.slice(0, 3).map((scene) => scene.id)).toEqual([both.id, dial.id, spin.id]);
    // Round rules nothing out.
    expect((await read("without=round")).scenes).toHaveLength(6);
  });

  it("puts the scenes moved by tilting first on a frame with an accelerometer, ruling none out", async () => {
    const { accountId } = await account("Publisher");
    for (let i = 0; i < 3; i += 1) {
      await storeScene(accountId, `Weather ${i}`);
    }
    const sand = await storeScene(accountId, "Sand", { category: "fun", needs: ["fast", "accelerometer"] });
    const tilt = await storeScene(accountId, "Tilt maze", { category: "games", needs: ["accelerometer"] });
    const read = async (query: string) =>
      (await (await getDeviceStore(get(`/api/store/device/scenes?${query}`))).json()) as {
        scenes: { id: string; needs?: string[] }[];
      };

    const first = await read("prefer=accelerometer");
    expect(first.scenes.slice(0, 2).map((scene) => scene.id).sort()).toEqual([sand.id, tilt.id].sort());
    expect(first.scenes.find((scene) => scene.id === tilt.id)?.needs).toEqual(["accelerometer"]);
    // A frame without one is still offered them: they play by touch or keys there.
    expect((await read("without=accelerometer")).scenes).toHaveLength(5);
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

  it("lists the updates a frame may take and takes them all in one push", async () => {
    const frame = await activeFrame();
    const clock = await storeScene(frame.accountId, "Clock", { visibility: "private" });
    const { accountId: publisherId } = await account("Publisher");
    const radar = await storeScene(publisherId, "Rain radar", { runtimeIds: ["radar-rt"] });
    const terminal = await storeScene(publisherId, "Terminal", { runtimeIds: ["term-rt"] });
    const current = await storeScene(publisherId, "Calendar", { runtimeIds: ["cal-rt"] });
    await assignScenes(frame.frame_id, [clock.id, radar.id, terminal.id, current.id]);
    // The owner's private scene has a newer version too: a frame names
    // public store scenes only.
    await addVersion(clock.id, 2, clock.runtimeIds, "Clock");
    await addVersion(radar.id, 2, ["radar-rt"], "Rain radar");
    await addVersion(radar.id, 3, ["radar-rt"], "Rain radar");
    // A version that starts asking for the frame's settings.
    const asksForFrame = {
      apps: { t: { sources: { "app.ts": "export function get() {}", "config.json": '{"permissions":["frame"]}' } } },
    };
    await addVersion(terminal.id, 2, ["term-rt"], "Terminal", [], false, asksForFrame);

    const listed = await panel(frame.frame_id, frame.access_token, { action: "updates" });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      ok: true,
      updates: [
        { from: 1, name: "Rain radar", store: radar.id, to: 3 },
        { from: 1, name: "Terminal", owner: true, store: terminal.id, to: 2 },
      ],
    });
    // A read sends nothing.
    expect(await newestPush(frame.frame_id)).toBeUndefined();

    // The one that asks for more is its owner's to update.
    const widened = await panel(frame.frame_id, frame.access_token, { action: "update", scene_id: terminal.id });
    expect(widened.status).toBe(403);
    expect(await widened.json()).toMatchObject({ error: "needs_owner", needs: ["frame"], ok: false });
    expect((await panel(frame.frame_id, frame.access_token, { action: "update", scene_id: clock.id })).status).toBe(404);

    const all = await panel(frame.frame_id, frame.access_token, { action: "updateAll" });
    expect(all.status).toBe(200);
    expect(await all.json()).toMatchObject({ kept: 1, ok: true, status: "queued", updated: 1 });
    // One push: the radar moved, the rest as the frame holds them.
    const pushes = await db
      .select({ id: frameCommands.id })
      .from(frameCommands)
      .where(and(eq(frameCommands.frameId, frame.frame_id), eq(frameCommands.type, "set_scenes")));
    expect(pushes).toHaveLength(1);
    const push = await newestPush(frame.frame_id);
    const versionOf = (id: string) =>
      (push?.scenes.find((scene) => scene.id === id)?.origin as { version?: string } | undefined)?.version;
    expect(versionOf("radar-rt")).toBe("3");
    expect(versionOf("term-rt")).toBe("1");
    expect(versionOf(clock.runtimeIds[0]!)).toBe("1");

    const again = await panel(frame.frame_id, frame.access_token, { action: "updateAll" });
    expect(await again.json()).toMatchObject({ kept: 1, ok: true, status: "up_to_date", updated: 0 });
    const after = await panel(frame.frame_id, frame.access_token, { action: "updates" });
    expect(((await after.json()) as { updates: { store: string }[] }).updates.map((row) => row.store)).toEqual([
      terminal.id,
    ]);
  });

  it("refuses an install that replaces a scene the frame holds and asks for more than it", async () => {
    const frame = await activeFrame();
    // The frame's own copy of the store's scene (imported from the device,
    // say), under the runtime id the store's version has.
    const own = await storeScene(frame.accountId, "Scene store", { visibility: "private", runtimeIds: ["store-rt"] });
    await assignScenes(frame.frame_id, [own.id]);
    const { accountId: publisherId } = await account("Publisher");
    const asksForFrame = {
      apps: { t: { sources: { "app.ts": "export function get() {}", "config.json": '{"permissions":["frame"]}' } } },
    };
    const store = await storeScene(publisherId, "Scene store", { runtimeIds: ["store-rt"] });
    await addVersion(store.id, 2, ["store-rt"], "Scene store", [], false, asksForFrame);

    // The store's version asks for the frame's settings, the copy did not:
    // the owner's, as an update that asks for more is.
    const widened = await panel(frame.frame_id, frame.access_token, { action: "install", scene_id: store.id });
    expect(widened.status).toBe(403);
    expect(await widened.json()).toEqual({ error: "needs_owner", needs: ["frame"], ok: false });
    expect((await assignedIds(frame.frame_id)).map((row) => row.sceneId)).toEqual([own.id]);
    expect(await newestPush(frame.frame_id)).toBeUndefined();

    // A scene the frame does not hold installs when it asks for nothing red.
    const reader = await storeScene(publisherId, "Reader", { runtimeIds: ["read-rt"] });
    await addVersion(reader.id, 2, ["read-rt"], "Reader", [], false, {
      apps: { t: { sources: { "app.ts": "export function get() {}", "config.json": '{"permissions":["assets"]}' } } },
    });
    const fresh = await panel(frame.frame_id, frame.access_token, { action: "install", scene_id: reader.id });
    expect(fresh.status).toBe(200);
    expect((await assignedIds(frame.frame_id)).map((row) => row.sceneId)).toEqual([own.id, reader.id]);
  });

  it("leaves a scene new to the frame that asks for a red permission to the owner", async () => {
    // The store on the frame shows no tags, and `storeAction` can be called
    // with nobody at the frame: a scene that reaches past its own data is
    // installed and previewed from the workspace, where its red tag is seen.
    const frame = await activeFrame();
    const clock = await storeScene(frame.accountId, "Clock", { visibility: "private" });
    await assignScenes(frame.frame_id, [clock.id]);
    const { accountId: publisherId } = await account("Publisher");
    const asking = (config: string, code = "export function get() {}") => ({
      apps: { t: { sources: { "app.ts": code, "config.json": config } } },
      nodes: [{ data: { keyword: "t" }, id: "n1", type: "app" }],
    });
    const cases: [string, Record<string, unknown>, string[]][] = [
      ["Terminal", asking('{"permissions":["frame"]}'), ["frame"]],
      ["Sketchbook", asking('{"permissions":["assets","assets-write"]}'), ["assets-write"]],
      ["Editor", asking('{"permissions":["code","store","files"]}'), ["code", "files", "store"]],
      // Code that calls a power counts when the app has no list of its own.
      ["Shop", asking('{"name":"Shop"}', "export function get() { frameos.storeAction('install', {}) }"), ["store"]],
      // A config.json only a lenient parser reads: everything, never nothing.
      ["Hidden", asking('{\n  // hidden\n  "permissions": ["frame"],\n}'), ["assets-write", "code", "frame", "store"]],
    ];
    for (const [name, extra, needs] of cases) {
      const scene = await storeScene(publisherId, name, { runtimeIds: [`${name}-rt`] });
      await addVersion(scene.id, 2, [`${name}-rt`], name, [], false, extra);
      for (const action of ["install", "preview"]) {
        const refused = await panel(frame.frame_id, frame.access_token, { action, scene_id: scene.id });
        expect(refused.status, `${action} ${name}`).toBe(403);
        expect(await refused.json()).toEqual({ error: "needs_owner", needs, ok: false });
      }
    }
    expect((await assignedIds(frame.frame_id)).map((row) => row.sceneId)).toEqual([clock.id]);
    expect(await newestPush(frame.frame_id)).toBeUndefined();
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

  it("tries a layout without leaving the scene showing, and keeping it puts it around every scene", async () => {
    const frame = await activeFrame();
    const clock = await storeScene(frame.accountId, "Clock", { visibility: "private" });
    await assignScenes(frame.frame_id, [clock.id]);
    const { accountId: publisherId } = await account("Publisher");
    const bar = await storeScene(publisherId, "Top bar", { category: "layouts", isLayout: true, runtimeIds: ["bar-rt"] });

    // Tried: beside the list as a preview, and nothing switches (the store wears it).
    const tried = await panel(frame.frame_id, frame.access_token, { action: "preview", scene_id: bar.id, show: false });
    expect(tried.status).toBe(200);
    expect(await tried.json()).toMatchObject({ ok: true, scene_id: "bar-rt" });
    const push = await newestPush(frame.frame_id);
    expect(push?.scenes.map((scene) => scene.id)).toEqual([clock.runtimeIds[0], "bar-rt"]);
    expect(push?.scene_id).toBeUndefined();
    expect(push?.preview).toMatchObject({ scene_id: "bar-rt", source: "panel" });

    // Kept: installed, and every scene the frame holds wears it.
    const kept = await panel(frame.frame_id, frame.access_token, { action: "install", scene_id: bar.id, show: true });
    expect(kept.status).toBe(200);
    expect((await assignedIds(frame.frame_id)).map((row) => row.sceneId)).toEqual([clock.id, bar.id]);
    const after = await newestPush(frame.frame_id);
    const worn = after?.scenes.find((scene) => scene.id === clock.runtimeIds[0]) as { layout?: unknown } | undefined;
    expect(worn?.layout).toEqual({ sceneId: "bar-rt" });
    expect(after?.scene_id).not.toBe("bar-rt");
  });
});
