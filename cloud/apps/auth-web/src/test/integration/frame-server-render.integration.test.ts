// Rendering on the server, end to end on auth-web (docs/server-rendering.md):
// a real Postgres, the real device route, the real verbs and the real plan
// check, with the wasm runtime stood in for by a renderer that paints a
// solid colour and reports what it was asked.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { asc, eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { NextRequest } from "next/server";
import {
  billingPlans,
  createDb,
  frameCommands,
  frameLogs,
  frames,
  frameSceneAssignments,
  frameServerRenders,
  linkedClients,
  storeScenes,
  storeSceneVersions,
  subscriptions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as pullRender, POST as pullRenderWithInput } from "../../../app/api/frames/[frameId]/embedded/render/route";
import { POST as postSettings } from "../../../app/api/frames/[frameId]/settings/route";
import {
  enqueueFrameCommand,
  frameManagedScope,
  frameTelemetryLogsScope,
} from "../../lib/frames";
import { cloudRenderedMinIntervalSeconds } from "../../lib/cloud-rendered";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import type { SceneRenderOptions, SceneRenderResult } from "../../lib/scene-render";
import { hashSecret } from "../../lib/secrets";
import { leaveBuiltInSceneForSleep, prerenderFrame, setServerRendererForTests } from "../../lib/server-render";
import { createSession, sessionCookieName } from "../../lib/session";
import { accountUsage, countCloudRenderedFramesForAccount } from "../../lib/usage";

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

// Every render the stand-in was asked for, the shade it paints next, and
// what it says of the render besides (the scene it ended on, the photo
// palette, the logs), as the runtime would.
let renders: SceneRenderOptions[] = [];
let shade = 0;
let painted: [number, number, number] | null = null;
let reports: Partial<SceneRenderResult> = {};

function standIn(options: SceneRenderOptions): Promise<SceneRenderResult> {
  renders.push(options);
  const rgba = new Uint8Array(options.width * options.height * 4).fill(shade);
  if (painted) {
    for (let i = 0; i < options.width * options.height; i += 1) {
      rgba.set(painted, i * 4);
    }
  }
  return Promise.resolve({
    errors: [],
    height: options.height,
    logs: [],
    png: Buffer.alloc(0),
    renderMs: 12,
    rgba,
    state: { count: (renders.length as number) * 1, secret: "kept out" },
    width: options.width,
    ...reports,
  });
}

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  renders = [];
  shade = 0;
  painted = null;
  reports = {};
  setServerRendererForTests(standIn);
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

afterEach(() => {
  setServerRendererForTests(undefined);
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

async function signIn() {
  userCounter += 1;
  const providerSubject = `server-render-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Server Render User ${userCounter}`,
    email: `server-render-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

// A paid plan the way "Sync plans" writes one.
async function subscribe(accountId: string, cloudRendered: number) {
  const code = `private-render-${cloudRendered}`;
  await db
    .insert(billingPlans)
    .values({
      code,
      entitlements: { cloud_rendered_frames: cloudRendered, frames: 40 },
      marginBasisPoints: 3000,
      name: "Private",
      priceMicros: BigInt(cloudRendered + 1) * 1_000_000n,
    })
    .onConflictDoNothing();
  await db.insert(subscriptions).values({ accountId, planCode: code });
}

const scenes = [
  {
    edges: [],
    fields: [
      { access: "public", name: "title", type: "string", value: "" },
      { access: "private", name: "secret", type: "string", value: "" },
      { access: "public", name: "count", type: "integer", value: 0 },
    ],
    id: "clock",
    name: "Clock",
    nodes: [],
  },
  { edges: [], fields: [{ access: "public", name: "title", type: "string" }], id: "weather", name: "Weather", nodes: [] },
];

// An ESP32-S3 frame of the account, with an assigned store scene holding
// `scenes`, and the device's bearer token.
async function createFrame(accountId: string, settings: Record<string, unknown> = { interval: 900, render_mode: "remote" }) {
  const token = `fc_link_${randomBytes(24).toString("base64url")}`;
  const { publicKey } = generateKeyPairSync("ed25519");
  const [linkedClient] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: [frameManagedScope, frameTelemetryLogsScope] },
      publicDisplayName: "Kitchen",
      tokenReference: hashSecret(token),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      frameosVersion: "2026.11.7",
      hardware: { height: 480, platform: "esp32-s3", width: 800 },
      linkedClientId: linkedClient!.id,
      name: "Kitchen",
      publicKey: Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url").toString("base64"),
      settings,
      status: "active",
    })
    .returning();
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      latestVersion: 1,
      name: "Clock",
      riskFlags: [],
      slug: `clock-${randomUUID().slice(0, 8)}`,
      status: "active",
      visibility: "private",
    })
    .returning();
  await db.insert(storeSceneVersions).values({
    content: Buffer.from(
      zipSync({
        "scene/scenes.json": new TextEncoder().encode(JSON.stringify(scenes)),
        "scene/template.json": new TextEncoder().encode(JSON.stringify({ name: "Clock" })),
      }),
    ),
    contentType: "application/zip",
    riskFlags: [],
    sceneId: scene!.id,
    sha256: "test",
    sizeBytes: 1000,
    version: 1,
  });
  await db.insert(frameSceneAssignments).values({ frameId: frame!.id, position: 0, sceneId: scene!.id });
  return { frame: frame!, token };
}

function pull(frameId: string, token: string, query: string, headers: Record<string, string> = {}) {
  return pullRender(
    new NextRequest(new URL(`/api/frames/${frameId}/embedded/render?${query}`, baseUrl), {
      headers: { authorization: `Bearer ${token}`, ...headers },
      method: "GET",
    }),
    { params: Promise.resolve({ frameId }) },
  );
}

function pullWithInput(frameId: string, token: string, query: string, body: string, headers: Record<string, string> = {}) {
  return pullRenderWithInput(
    new NextRequest(new URL(`/api/frames/${frameId}/embedded/render?${query}`, baseUrl), {
      body,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      method: "POST",
    }),
    { params: Promise.resolve({ frameId }) },
  );
}

function pushSettings(frameId: string, settings: Record<string, unknown>) {
  return postSettings(
    new NextRequest(new URL(`/api/frames/${frameId}/settings`, baseUrl), {
      body: JSON.stringify({ settings }),
      headers: { "content-type": "application/json", origin: baseUrl },
      method: "POST",
    }),
    { params: Promise.resolve({ frameId }) },
  );
}

async function renderRow(frameId: string) {
  const [row] = await db.select().from(frameServerRenders).where(eq(frameServerRenders.frameId, frameId));
  return row;
}

const panel = "width=800&height=480&format=1";

describe("the render pull", () => {
  it("is for frames the cloud renders for, with a panel to draw to", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 2);
    const local = await createFrame(accountId, { interval: 900 });
    const refused = await pull(local.frame.id, local.token, panel);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "not_server_rendered" });

    const remote = await createFrame(accountId);
    expect((await pull(remote.frame.id, remote.token, "width=800&height=480")).status).toBe(400);
    expect((await pull(remote.frame.id, "fc_link_nope", panel)).status).toBe(401);
    expect((await pull(local.frame.id, remote.token, panel)).status).toBe(403);
    expect(renders).toHaveLength(0);
  });

  it("hands out the packed picture, then a 304 for the same one", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);

    shade = 255;
    const first = await pull(frame.id, token, panel);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const body = Buffer.from(await first.arrayBuffer());
    expect(body.subarray(0, 4).toString("latin1")).toBe("FOSB");
    expect(body[5]).toBe(1);
    expect(body.readUInt16LE(6)).toBe(800);
    expect(body.readUInt16LE(8)).toBe(480);
    expect(body.length).toBe(12 + 48_000);
    expect([...body.subarray(12, 20)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({ height: 480, owner: accountId, rawRgba: true, sceneId: "clock", width: 800 });

    // What the scene kept, public and persisted fields only.
    const row = await renderRow(frame.id);
    expect(row?.states).toEqual({ clock: { count: 1 } });
    expect(row?.activeScene).toBe("clock");

    // The same picture, asked for again inside the floor: not drawn again.
    const again = await pull(frame.id, token, `${panel}&scene=clock`, { "if-none-match": etag! });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(renders).toHaveLength(1);
    const unconditional = await pull(frame.id, token, `${panel}&scene=clock`);
    expect(unconditional.status).toBe(200);
    expect(renders).toHaveLength(1);

    // The scene's line on the frame's log.
    const logs = await db.select().from(frameLogs).where(eq(frameLogs.frameId, frame.id));
    expect(logs.map((log) => (log.payload as Record<string, unknown>).event)).toContain("render:server");
  });

  it("draws a portrait frame on the swapped canvas", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    const response = await pull(frame.id, token, `${panel}&rotate=90`);
    expect(response.status).toBe(200);
    expect(renders[0]).toMatchObject({ height: 800, width: 480 });
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.readUInt16LE(6)).toBe(800);
  });

  it("draws the scene the device is on, unless a switch it has not taken is waiting", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);

    expect((await pull(frame.id, token, `${panel}&scene=weather`)).status).toBe(200);
    expect(renders.at(-1)?.sceneId).toBe("weather");

    // The owner switches to the clock with a title; the device has not
    // heard it yet and still says "weather".
    await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { scene_id: "clock", state: { secret: "nope", title: "Hello" } },
      type: "set_current_scene",
    });
    expect((await pull(frame.id, token, `${panel}&scene=weather`)).status).toBe(200);
    expect(renders.at(-1)?.sceneId).toBe("clock");
    // Folded in, public fields only.
    expect(renders.at(-1)?.states).toMatchObject({ clock: { title: "Hello" } });
    expect((renders.at(-1)?.states as Record<string, Record<string, unknown>>).clock?.secret).toBeUndefined();
    const row = await renderRow(frame.id);
    expect(row?.pendingStates).toEqual({});

    // Once the device took it, its own word counts again.
    await db.update(frameCommands).set({ status: "acked" }).where(eq(frameCommands.frameId, frame.id));
    expect((await pull(frame.id, token, `${panel}&scene=weather`)).status).toBe(200);
    expect(renders.at(-1)?.sceneId).toBe("weather");
  });

  it("holds a scene event for the next pull and asks the device to pull", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    expect((await pull(frame.id, token, panel)).status).toBe(200);

    const command = await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { name: "nextPhoto", payload: { step: 1 } },
      type: "scene_event",
    });
    expect(command?.type).toBe("render");
    expect((await renderRow(frame.id))?.pendingEvents).toEqual([
      { name: "nextPhoto", origin: "cloud", payload: { step: 1 } },
    ]);

    // Inside the floor, but something changed: drawn again, with the event.
    expect((await pull(frame.id, token, `${panel}&scene=clock`)).status).toBe(200);
    expect(renders).toHaveLength(2);
    expect(renders[1]?.events).toEqual([{ name: "nextPhoto", origin: "cloud", payload: { step: 1 } }]);
    expect((await renderRow(frame.id))?.pendingEvents).toEqual([]);

    // setSceneState is state, kept for the scene drawn last.
    const state = await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { name: "setSceneState", payload: { render: true, state: { title: "Set" } } },
      type: "scene_event",
    });
    expect(state?.type).toBe("render");
    expect((await renderRow(frame.id))?.pendingStates).toEqual({ clock: { title: "Set" } });
  });

  it("takes the picture drawn before the wake, once, and commits its state then", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    // The first pull tells the plane the panel.
    expect((await pull(frame.id, token, panel)).status).toBe(200);

    const asOf = new Date(Date.now() + 30_000);
    shade = 255;
    expect(await prerenderFrame(db, frame.id, { asOf, render: standIn })).toBe("kept");
    expect(renders).toHaveLength(2);
    expect(renders[1]?.nowMs).toBe(asOf.getTime());
    let row = await renderRow(frame.id);
    expect(row?.prerenderScene).toBe("clock");
    // Not committed until it is taken.
    expect(row?.states).toEqual({ clock: { count: 1 } });

    // Past the floor, so the last picture is not reused; the pre-render is.
    await db
      .update(frameServerRenders)
      .set({ renderedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(frameServerRenders.frameId, frame.id));
    const woke = await pull(frame.id, token, `${panel}&scene=clock`);
    expect(woke.status).toBe(200);
    expect(renders).toHaveLength(2);
    const body = Buffer.from(await woke.arrayBuffer());
    expect(body[12]).toBe(0xff);
    row = await renderRow(frame.id);
    expect(row?.prerender).toBeNull();
    expect(row?.states).toEqual({ clock: { count: 2 } });
  });

  it("says when the scene wants its next picture, on every answer for the picture", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);

    // The scene's own interval, held to the plan's floor.
    reports = { refreshInterval: 900 };
    const first = await pull(frame.id, token, panel);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-frameos-next-render")).toBe("900");
    expect((await renderRow(frame.id))?.pictureNextRenderSeconds).toBe(900);
    const etag = first.headers.get("etag")!;
    // A 304 and a reused picture answer for the picture they stand for.
    const unchanged = await pull(frame.id, token, panel, { "if-none-match": etag });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("x-frameos-next-render")).toBe("900");
    expect(unchanged.headers.get("x-frameos-scene")).toBe("clock");
    const reused = await pull(frame.id, token, panel);
    expect(reused.status).toBe(200);
    expect(renders).toHaveLength(1);
    expect(reused.headers.get("x-frameos-next-render")).toBe("900");

    // A picture drawn before a wake keeps its own: here the render's nextSleep.
    reports = { nextSleep: 3600, refreshInterval: 900 };
    shade = 255;
    expect(await prerenderFrame(db, frame.id, { asOf: new Date(Date.now() + 30_000), render: standIn })).toBe("kept");
    expect((await renderRow(frame.id))?.prerenderNextRenderSeconds).toBe(3600);
    await db
      .update(frameServerRenders)
      .set({ renderedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(frameServerRenders.frameId, frame.id));
    const woke = await pull(frame.id, token, panel);
    expect(woke.status).toBe(200);
    expect(renders).toHaveLength(2);
    expect(woke.headers.get("x-frameos-next-render")).toBe("3600");
    const taken = await renderRow(frame.id);
    expect(taken?.prerenderNextRenderSeconds).toBeNull();
    expect(taken?.pictureNextRenderSeconds).toBe(3600);

    // A clock that wants every second waits the plan's floor; a scene with
    // no opinion says nothing, and the board keeps the frame's interval.
    await db
      .update(frameServerRenders)
      .set({ renderedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(frameServerRenders.frameId, frame.id));
    reports = { refreshInterval: 1 };
    const fast = await pull(frame.id, token, panel);
    expect(fast.headers.get("x-frameos-next-render")).toBe(String(cloudRenderedMinIntervalSeconds));
    await db
      .update(frameServerRenders)
      .set({ renderedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(frameServerRenders.frameId, frame.id));
    reports = {};
    const silent = await pull(frame.id, token, panel);
    expect(silent.status).toBe(200);
    expect(silent.headers.get("x-frameos-next-render")).toBeNull();
    expect((await renderRow(frame.id))?.pictureNextRenderSeconds).toBeNull();
  });

  it("keeps no pre-render past a change, and draws none while an event waits", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    expect((await pull(frame.id, token, panel)).status).toBe(200);
    const asOf = new Date(Date.now() + 30_000);
    expect(await prerenderFrame(db, frame.id, { asOf, render: standIn })).toBe("kept");
    await enqueueFrameCommand(db, { frameId: frame.id, payload: { name: "tap" }, type: "scene_event" });
    await db
      .update(frameServerRenders)
      .set({ renderedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(frameServerRenders.frameId, frame.id));
    expect((await pull(frame.id, token, `${panel}&scene=clock`)).status).toBe(200);
    // Drawn again, with the event: the kept picture was from before it.
    expect(renders).toHaveLength(3);
    expect(renders[2]?.events).toEqual([{ name: "tap", origin: "cloud", payload: {} }]);

    await enqueueFrameCommand(db, { frameId: frame.id, payload: { name: "tap" }, type: "scene_event" });
    expect(await prerenderFrame(db, frame.id, { asOf, render: standIn })).toBe("events_pending");
  });
});

describe("keys, touch and the schedule", () => {
  const press = {
    events: [
      { name: "gpio", origin: "driver", payload: { action: "down", atMs: 80_410, label: "RIGHT", level: 0, pin: 3 } },
      { name: "gpio", origin: "driver", payload: { action: "up", atMs: 81_020, label: "RIGHT", level: 1, pin: 3 } },
      { name: "setCurrentScene", origin: "schedule", payload: { sceneId: "weather" } },
      // The plane's own: never relayed, never delivered.
      { name: "nextPhoto", origin: "cloud", payload: {} },
    ],
    nowMs: 81_234,
  };

  it("go into the render, after the events the plane held, and never reuse a picture", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    const first = await pull(frame.id, token, panel);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    await enqueueFrameCommand(db, { frameId: frame.id, payload: { name: "tap" }, type: "scene_event" });

    // Inside the floor with the same picture: still drawn, for the input.
    const pressed = await pullWithInput(frame.id, token, panel, JSON.stringify(press), { "if-none-match": etag });
    expect(pressed.status).toBe(304);
    expect(renders).toHaveLength(2);
    expect(renders[1]?.events).toEqual([{ name: "tap", origin: "cloud", payload: {} }]);
    expect(renders[1]?.deviceInput).toEqual({ edges: [], events: press.events.slice(0, 3), nowMs: 81_234 });

    // An empty body is a pull like a GET: the last picture again.
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify({ edges: [], nowMs: 5 }))).status).toBe(200);
    expect(renders).toHaveLength(2);

    // The Pico's edges are taken too.
    const pico = { edges: [{ action: "down", atMs: 10, label: "A", pin: -1 }, { action: "up", atMs: 90, label: "A", pin: -1 }], nowMs: 100 };
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(pico))).status).toBe(200);
    expect(renders[2]?.deviceInput).toEqual({ ...pico, events: [] });
  });

  it("refuses a body that is not input", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    for (const body of ["{", "[]", JSON.stringify({ events: [] }), JSON.stringify({ events: {}, nowMs: 1 })]) {
      const refused = await pullWithInput(frame.id, token, panel, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_input" });
    }
    const huge = JSON.stringify({ events: [{ name: "x", origin: "driver", payload: { pad: "y".repeat(17_000) } }], nowMs: 1 });
    expect((await pullWithInput(frame.id, token, panel, huge)).status).toBe(413);
    // Who is asking is checked before the body is read.
    expect((await pullWithInput(frame.id, "fc_link_nope", panel, "{")).status).toBe(401);
    expect(renders).toHaveLength(0);
  });

  it("leave the plane on the scene the render ended on, with its state", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    expect((await pull(frame.id, token, panel)).status).toBe(200);

    reports = { sceneId: "weather", state: { secret: "kept out", title: "Switched" } };
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    let row = await renderRow(frame.id);
    expect(row?.activeScene).toBe("weather");
    expect(row?.pictureScene).toBe("weather");
    expect(row?.states).toEqual({ clock: { count: 1 }, weather: { title: "Switched" } });
    // The frame's row says so too, as a device's report would: what the
    // workspace shows and what custom events are routed against.
    const [shown] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(shown?.lastState).toEqual({ active_scene: "weather", clock: { count: 1 }, weather: { title: "Switched" } });

    // The next timed pull draws it.
    reports = {};
    await db
      .update(frameServerRenders)
      .set({ renderedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(frameServerRenders.frameId, frame.id));
    expect((await pull(frame.id, token, panel)).status).toBe(200);
    expect(renders.at(-1)?.sceneId).toBe("weather");
    // An id the frame has no scene for is not one to keep.
    reports = { sceneId: "gone" };
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    row = await renderRow(frame.id);
    expect(row?.activeScene).toBe("weather");
  });

  it("keep the switcher a swipe opened while the frame is awake, and leave it when it sleeps", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    expect((await pull(frame.id, token, panel)).status).toBe(200);

    reports = { sceneId: "system/sceneSwitcher", state: { from: "clock", highlight: 1 } };
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    let row = await renderRow(frame.id);
    expect(row?.activeScene).toBe("system/sceneSwitcher");
    expect(row?.states).toMatchObject({ "system/sceneSwitcher": { from: "clock", highlight: 1 } });
    // The frame's scene, as the row reports it, is the one the switcher was opened over.
    const lastState = async () => (await db.select().from(frames).where(eq(frames.id, frame.id)))[0]?.lastState;
    expect(await lastState()).toEqual({ active_scene: "clock", clock: { count: 1 } });

    // A tap on a tile lands in the switcher it opened, with its state.
    reports = { sceneId: "weather", state: { title: "Picked" } };
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    expect(renders.at(-1)?.sceneId).toBe("system/sceneSwitcher");
    expect(renders.at(-1)?.states).toMatchObject({ "system/sceneSwitcher": { from: "clock", highlight: 1 } });
    expect((await renderRow(frame.id))?.activeScene).toBe("weather");

    // Open again, then the frame goes to sleep: back to where it was opened from.
    reports = { sceneId: "system/sceneSwitcher", state: { from: "weather" } };
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    expect(await leaveBuiltInSceneForSleep(db, frame.id)).toBe(true);
    row = await renderRow(frame.id);
    expect(row?.activeScene).toBe("weather");
    expect(await lastState()).toMatchObject({ active_scene: "weather", weather: { title: "Picked" } });
    expect(row?.states).not.toHaveProperty("system/sceneSwitcher");
    expect(await leaveBuiltInSceneForSleep(db, frame.id)).toBe(false);
  });

  it("keep what the render process kept between two pulls, and forget it when the frame sleeps", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    expect((await pull(frame.id, token, panel)).status).toBe(200);
    expect(renders[0]?.keptState).toBeUndefined();

    // A tap focuses a field: the keyboard opens, the app remembers its
    // draft, and the plane keeps both.
    const typing = JSON.stringify({
      apps: [{ memory: { draft: '{"name":"ab"}' }, nodeId: 4, sceneId: "clock" }],
      targets: [{ focus: 2, keyboard: true, nodeId: 4, sceneId: "clock", text: "ab" }],
    });
    reports = { keptState: typing };
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    expect((await renderRow(frame.id))?.keptState).toBe(typing);

    // The tap on a key meets it; a runtime that says nothing leaves it.
    reports = {};
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    expect(renders.at(-1)?.keptState).toBe(typing);
    expect((await renderRow(frame.id))?.keptState).toBe(typing);

    // A timed pull past the floor hands it over too.
    await db
      .update(frameServerRenders)
      .set({ renderedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(frameServerRenders.frameId, frame.id));
    expect((await pull(frame.id, token, panel)).status).toBe(200);
    expect(renders.at(-1)?.keptState).toBe(typing);

    // Nothing lasting is nothing kept; past 512 KiB is dropped.
    reports = { keptState: "{}" };
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    expect((await renderRow(frame.id))?.keptState).toBeNull();
    reports = { keptState: JSON.stringify({ text: "x".repeat(513 * 1024) }) };
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    expect((await renderRow(frame.id))?.keptState).toBeNull();
    const count = renders.length;
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    expect(renders).toHaveLength(count + 1);
    expect(renders.at(-1)?.keptState).toBeUndefined();

    // The picture drawn for a wake starts from none, and the sleep forgets
    // it: a picture that showed the keyboard is not handed out again.
    reports = { keptState: typing };
    expect((await pullWithInput(frame.id, token, panel, JSON.stringify(press))).status).toBe(200);
    reports = {};
    expect(await prerenderFrame(db, frame.id, { asOf: new Date(Date.now() + 30_000), render: standIn })).toBe("kept");
    expect(renders.at(-1)?.keptState).toBeUndefined();
    expect((await renderRow(frame.id))?.keptState).toBe(typing);
    const before = (await renderRow(frame.id))!.revision;
    expect(await leaveBuiltInSceneForSleep(db, frame.id)).toBe(false);
    const row = await renderRow(frame.id);
    expect(row?.keptState).toBeNull();
    expect(row?.revision).toBe(before + 1);
    // Inside the floor, yet drawn again: the kept picture had the keyboard.
    const drawnBefore = renders.length;
    expect((await pull(frame.id, token, panel)).status).toBe(200);
    expect(renders).toHaveLength(drawnBefore + 1);
    expect(renders.at(-1)?.keptState).toBeUndefined();
    // Nothing to forget: nothing moves.
    const settled = (await renderRow(frame.id))!.revision;
    expect(await leaveBuiltInSceneForSleep(db, frame.id)).toBe(false);
    expect((await renderRow(frame.id))?.revision).toBe(settled);
  });

  it("render with the frame's event map, palette and panel, and dither to its palette", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const eventMap = [{ as: { direction: "next", event: "setCurrentScene" }, event: "longPress", match: { label: "RIGHT" } }];
    // A Spectra 6 panel whose measured "green" (index 6) is the bluest colour it shows.
    const colors = ["#000000", "#ffffff", "#ffff00", "#ff0000", "#808080", "#0000ff"];
    const { frame, token } = await createFrame(accountId, {
      event_map: eventMap,
      interval: 900,
      palette: { colors, name: "Measured" },
      render_mode: "remote",
    });
    painted = [0, 0, 255];
    const spectra = "width=800&height=480&format=7&rotate=180";
    const drawn = await pull(frame.id, token, spectra);
    expect(drawn.status).toBe(200);
    expect(renders[0]?.frame).toEqual({ eventMap, palette: colors, pixelFormat: 7, rotate: 180 });
    let body = Buffer.from(await drawn.arrayBuffer());
    expect(body[12]).toBe(0x66);

    // A photo's own palette, as the render reports it, wins for that picture.
    reports = { palette: ["#000000", "#ffffff", "#ffff00", "#ff0000", "#0000ff", "#00ff00"] };
    body = Buffer.from(await (await pullWithInput(frame.id, token, spectra, JSON.stringify(press))).arrayBuffer());
    expect(body[12]).toBe(0x55);
  });
});

describe("the switch", () => {
  it("takes one of the plan's cloud-rendered frames, and refuses past the plan", async () => {
    const accountId = await signIn();
    const { frame } = await createFrame(accountId, { interval: 900 });
    const refused = await pushSettings(frame.id, { render_mode: "remote" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: "cloud_rendered_frame_quota_exceeded",
      max_cloud_rendered_frames: 0,
    });

    await subscribe(accountId, 1);
    const accepted = await pushSettings(frame.id, { render_mode: "remote" });
    expect(accepted.status).toBe(200);
    const [stored] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(stored?.settings).toMatchObject({ render_mode: "remote" });
    expect(await countCloudRenderedFramesForAccount(db, accountId)).toBe(1);
    expect((await accountUsage(db, accountId)).cloud_rendered_frames).toMatchObject({ count: 1, max_count: 1 });
    const [pushed] = await db.select().from(frameCommands).where(eq(frameCommands.frameId, frame.id));
    expect(pushed?.payload).toMatchObject({ settings: { render_mode: "remote" } });

    // Already one: another push to it is not a second place.
    expect((await pushSettings(frame.id, { render_mode: "remote" })).status).toBe(200);
    const second = await createFrame(accountId, { interval: 900 });
    expect((await pushSettings(second.frame.id, { render_mode: "remote" })).status).toBe(403);
    // Back to the frame's own runtime is always free.
    expect((await pushSettings(frame.id, { render_mode: "local" })).status).toBe(200);
    expect(await countCloudRenderedFramesForAccount(db, accountId)).toBe(0);
  });

  it("sends the scenes again behind it, both ways, so the board drops them or gets them back", async () => {
    // docs/server-rendering.md "Nothing to keep on the board": the hub sends
    // a board the cloud renders for the empty scene, decided as each push
    // goes, so the switch is followed by a push for it to decide on.
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame } = await createFrame(accountId, { interval: 900 });
    await db.update(frames).set({ assignedChecksum: "assigned" }).where(eq(frames.id, frame.id));
    const commands = async () =>
      (await db.select().from(frameCommands).where(eq(frameCommands.frameId, frame.id)).orderBy(asc(frameCommands.createdAt))).map(
        (row) => row.type,
      );

    expect((await pushSettings(frame.id, { render_mode: "remote" })).status).toBe(200);
    expect(await commands()).toEqual(["set_settings", "set_scenes"]);
    expect((await pushSettings(frame.id, { interval: 1200 })).status).toBe(200);
    expect(await commands()).toEqual(["set_settings", "set_scenes", "set_settings"]);
    expect((await pushSettings(frame.id, { render_mode: "local" })).status).toBe(200);
    expect((await commands()).slice(-2)).toEqual(["set_settings", "set_scenes"]);
  });

  it("holds the frame to the plan's refresh floor", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 2);
    const fast = await createFrame(accountId, { interval: 60 });
    const tooFast = await pushSettings(fast.frame.id, { render_mode: "remote" });
    expect(tooFast.status).toBe(400);
    expect(await tooFast.json()).toMatchObject({ error: "interval_below_plan_floor", min_interval: 300 });
    expect((await pushSettings(fast.frame.id, { interval: 600, render_mode: "remote" })).status).toBe(200);
    const under = await pushSettings(fast.frame.id, { interval: 120 });
    expect(under.status).toBe(400);
  });

  it("needs firmware that knows it", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame } = await createFrame(accountId, { interval: 900 });
    await db.update(frames).set({ frameosVersion: "2026.11.6" }).where(eq(frames.id, frame.id));
    const refused = await pushSettings(frame.id, { render_mode: "remote" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: "settings_need_newer_firmware",
      min_frameos_version: "2026.11.7",
    });
  });

  it("stops drawing for an account over its plan", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const one = await createFrame(accountId);
    await createFrame(accountId);
    const response = await pull(one.frame.id, one.token, panel);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "cloud_rendered_frame_quota_exceeded",
      max_cloud_rendered_frames: 1,
    });
  });
});

describe("only what changed, and the click", () => {
  // A picture, then the same with four rows gone black: what a tap on a
  // field does to a form.
  let band = false;
  function banded(options: SceneRenderOptions): Promise<SceneRenderResult> {
    renders.push(options);
    const rgba = new Uint8Array(options.width * options.height * 4).fill(255);
    if (band) {
      rgba.fill(0, options.width * 4 * 100, options.width * 4 * 104);
    }
    return Promise.resolve({
      errors: [],
      height: options.height,
      logs: [],
      png: Buffer.alloc(0),
      pressMap: "10,20,110,70;!0,0,200,100",
      renderMs: 5,
      rgba,
      state: {},
      width: options.width,
    });
  }

  const tap = {
    events: [
      { name: "pointerDown", origin: "driver", payload: { atMs: 900, button: 0, buttons: 1, pointerId: 1, pointerType: "touch", x: 10, y: 10 } },
      { name: "pointerUp", origin: "driver", payload: { atMs: 980, button: 0, buttons: 0, pointerId: 1, pointerType: "touch", x: 10, y: 10 } },
    ],
    nowMs: 2_000,
  };

  it("sends a board that reads version 2 its picture deflated, then what changed since", async () => {
    band = false;
    setServerRendererForTests(banded);
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    const v2 = { "x-frameos-fosb": "2" };

    const first = await pull(frame.id, token, panel, v2);
    expect(first.status).toBe(200);
    const whole = Buffer.from(await first.arrayBuffer());
    expect(whole.subarray(0, 5).toString("latin1")).toBe("FOSB\u0002");
    expect(whole.readUInt16LE(10)).toBe(2);
    const picture = inflateRawSync(whole.subarray(44));
    expect(picture.length).toBe(48_000);
    expect(createHash("sha256").update(picture).digest()).toEqual(whole.subarray(12, 44));
    // The ETag names the picture, whatever its encoding.
    const etag = first.headers.get("etag")!;
    const v1 = Buffer.concat([Buffer.from("FOSB\u0001", "latin1"), whole.subarray(5, 10), Buffer.alloc(2), picture]);
    expect(etag).toBe(`"${createHash("sha256").update(v1).digest("hex").slice(0, 32)}"`);

    // A tap: the rows that changed, against the picture the board shows.
    band = true;
    const tapped = await pullWithInput(frame.id, token, panel, JSON.stringify(tap), { ...v2, "if-none-match": etag });
    expect(tapped.status).toBe(200);
    const delta = Buffer.from(await tapped.arrayBuffer());
    expect(delta.readUInt16LE(10)).toBe(3);
    expect(delta.length).toBeLessThan(whole.length);
    const payload = inflateRawSync(delta.subarray(44));
    const after = Buffer.from(picture);
    for (let at = 0; at < payload.length; ) {
      const offset = payload.readUInt32LE(at);
      const length = payload.readUInt32LE(at + 4);
      payload.copy(after, offset, at + 8, at + 8 + length);
      at += 8 + length;
    }
    expect(createHash("sha256").update(after).digest()).toEqual(delta.subarray(12, 44));
    expect([...after.subarray(100 * 100, 100 * 100 + 4)]).toEqual([0, 0, 0, 0]);

    // A board that shows something else gets it whole; one that does not
    // say it reads version 2, version 1 as ever.
    const stranger = await pull(frame.id, token, panel, { ...v2, "if-none-match": '"0123456789abcdef0123456789abcdef"' });
    expect(Buffer.from(await stranger.arrayBuffer()).readUInt16LE(10)).toBe(2);
    const old = await pull(frame.id, token, panel);
    const oldBody = Buffer.from(await old.arrayBuffer());
    expect(oldBody[4]).toBe(1);
    expect(oldBody.subarray(12)).toEqual(after);
  });

  it("says where a press does something, on the picture and on its 304", async () => {
    band = false;
    setServerRendererForTests(banded);
    const accountId = await signIn();
    await subscribe(accountId, 1);
    const { frame, token } = await createFrame(accountId);
    const first = await pull(frame.id, token, panel);
    expect(first.headers.get("x-frameos-press")).toBe("10,20,110,70;!0,0,200,100");
    expect((await renderRow(frame.id))?.picturePressMap).toBe("10,20,110,70;!0,0,200,100");
    const same = await pull(frame.id, token, panel, { "if-none-match": first.headers.get("etag")! });
    expect(same.status).toBe(304);
    expect(same.headers.get("x-frameos-press")).toBe("10,20,110,70;!0,0,200,100");

    // Drawn before a wake: its own, taken with it.
    expect(await prerenderFrame(db, frame.id, { asOf: new Date(Date.now() + 30_000), render: banded })).toBe("kept");
    expect((await renderRow(frame.id))?.prerenderPressMap).toBe("10,20,110,70;!0,0,200,100");
  });
});
