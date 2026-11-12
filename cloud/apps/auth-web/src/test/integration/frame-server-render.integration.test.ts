// Rendering on the server, end to end on auth-web (docs/server-rendering.md):
// a real Postgres, the real device route, the real verbs and the real plan
// check, with the wasm runtime stood in for by a renderer that paints a
// solid colour and reports what it was asked.
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
import { GET as pullRender } from "../../../app/api/frames/[frameId]/embedded/render/route";
import { POST as postSettings } from "../../../app/api/frames/[frameId]/settings/route";
import {
  enqueueFrameCommand,
  frameManagedScope,
  frameTelemetryLogsScope,
} from "../../lib/frames";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import type { SceneRenderOptions, SceneRenderResult } from "../../lib/scene-render";
import { hashSecret } from "../../lib/secrets";
import { prerenderFrame, setServerRendererForTests } from "../../lib/server-render";
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

// Every render the stand-in was asked for, and the shade it paints next.
let renders: SceneRenderOptions[] = [];
let shade = 0;

function standIn(options: SceneRenderOptions): Promise<SceneRenderResult> {
  renders.push(options);
  const rgba = new Uint8Array(options.width * options.height * 4).fill(shade);
  return Promise.resolve({
    errors: [],
    height: options.height,
    logs: [],
    png: Buffer.alloc(0),
    renderMs: 12,
    rgba,
    state: { count: (renders.length as number) * 1, secret: "kept out" },
    width: options.width,
  });
}

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  renders = [];
  shade = 0;
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
