// Rendering on the server, the hub's part (docs/server-rendering.md "Deep
// sleep"): a frame the cloud renders for says it is going to sleep, and the
// hub draws the picture it will pull at its wake before it wakes, with the
// scene's clock at that wake. A real hub, a real Postgres, a stand-in for the
// wasm runtime.
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  accounts,
  createDb,
  frames,
  frameSceneAssignments,
  frameServerRenders,
  linkedClients,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { frameManagedScope } from "../../../../auth-web/src/lib/frames";
import type { SceneRenderOptions, SceneRenderResult } from "../../../../auth-web/src/lib/scene-render";
import { hashSecret } from "../../../../auth-web/src/lib/secrets";
import { pullServerRender, type PrerenderOutcome } from "../../../../auth-web/src/lib/server-render";
import { startFrameHub, type FrameHub } from "../../hub";

const db = createDb();
const hubs: FrameHub[] = [];
let renders: SceneRenderOptions[] = [];
let outcomes: { frameId: string; outcome: PrerenderOutcome }[] = [];

async function standIn(options: SceneRenderOptions): Promise<SceneRenderResult> {
  renders.push(options);
  return {
    errors: [],
    height: options.height,
    logs: [],
    png: Buffer.alloc(0),
    // The scene wants its next picture in half an hour (docs/server-rendering.md).
    refreshInterval: 1800,
    renderMs: 5,
    rgba: new Uint8Array(options.width * options.height * 4).fill(255),
    state: { count: 7 },
    width: options.width,
  };
}

async function startHub() {
  const hub = await startFrameHub({
    onPrerender: (frameId, outcome) => outcomes.push({ frameId, outcome }),
    port: 0,
    // Half a second before the wake, so a two-second sleep is drawn in 1.5 s.
    prerenderLeadMs: () => 500,
    virtualRender: standIn,
    virtualTickIntervalMs: 3_600_000,
  });
  hubs.push(hub);
  return hub;
}

beforeEach(async () => {
  renders = [];
  outcomes = [];
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "schema_migrations")
    .map((name) => `"${name}"`);
  await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(", ")} CASCADE`));
});

afterEach(async () => {
  while (hubs.length > 0) {
    await hubs.pop()?.close();
  }
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function createFrame(settings: Record<string, unknown>) {
  const [account] = await db.insert(accounts).values({ displayName: "Render Tester" }).returning();
  const token = `fc_link_${randomBytes(24).toString("base64url")}`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const [linkedClient] = await db
    .insert(linkedClients)
    .values({
      accountId: account!.id,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: [frameManagedScope] },
      publicDisplayName: "Hall",
      tokenReference: hashSecret(token),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId: account!.id,
      linkedClientId: linkedClient!.id,
      name: "Hall",
      publicKey: Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url").toString("base64"),
      settings,
      status: "active",
    })
    .returning();
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId: account!.id,
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
        "scene/scenes.json": new TextEncoder().encode(
          JSON.stringify([
            { edges: [], fields: [{ access: "public", name: "count", type: "integer" }], id: "clock", name: "Clock", nodes: [] },
            { edges: [], fields: [{ access: "public", name: "count", type: "integer" }], id: "weather", name: "Weather", nodes: [] },
          ]),
        ),
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
  // The panel an earlier pull named.
  await db.insert(frameServerRenders).values({ activeScene: "clock", frameId: frame!.id, picturePanel: "800x480/1/0" });
  return { frame: frame!, linkedClient: linkedClient!, privateKey, token };
}

// Connect as the device, say hello, and go to sleep for `wakeInSeconds`.
async function sleepFor(port: number, token: string, privateKey: KeyObject, wakeInSeconds: number, nextRenderAt?: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/frames/ws`, { headers: { authorization: `Bearer ${token}` } });
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
  const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const challenge = await waitFor(() => messages.find((msg) => msg.type === "challenge"), "challenge");
  ws.send(
    JSON.stringify({
      frameos_version: "2026.11.7",
      hardware: { height: 480, platform: "esp32-s3", width: 800 },
      id: randomUUID(),
      states: { active_scene: "clock" },
      type: "hello",
    }),
  );
  ws.send(
    JSON.stringify({
      id: randomUUID(),
      signature: sign(null, Buffer.from(String(challenge.nonce), "base64"), privateKey).toString("base64"),
      type: "auth",
    }),
  );
  await waitFor(() => messages.find((msg) => msg.type === "ready"), "ready");
  ws.send(
    JSON.stringify({
      reason: "battery",
      type: "sleep",
      wake_in_seconds: wakeInSeconds,
      ...(nextRenderAt ? { next_render_at: nextRenderAt } : {}),
    }),
  );
  await closed;
}

describe("a sleeping frame the cloud renders for", () => {
  it("gets its next picture drawn before it wakes, as of the wake's render time", async () => {
    const hub = await startHub();
    const { frame, privateKey, token } = await createFrame({ render_mode: "remote" });
    const renderAt = Math.floor(Date.now() / 1000) + 2;
    await sleepFor(hub.port, token, privateKey, 2, renderAt);

    const outcome = await waitFor(() => outcomes.find((entry) => entry.frameId === frame.id), "pre-render");
    expect(outcome.outcome).toBe("kept");
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({ height: 480, nowMs: renderAt * 1000, rawRgba: true, sceneId: "clock", width: 800 });
    const [row] = await db.select().from(frameServerRenders).where(eq(frameServerRenders.frameId, frame.id));
    expect(row?.prerenderScene).toBe("clock");
    expect(row?.prerenderAsOf?.getTime()).toBe(renderAt * 1000);
    expect(row?.prerenderState).toEqual({ clock: { count: 7 } });
    // When the scene wants the picture after it, for the pull that takes it.
    expect(row?.prerenderNextRenderSeconds).toBe(1800);
    expect(row?.prerender?.subarray(0, 4).toString("latin1")).toBe("FOSB");
    // Kept, not committed: the pull at the wake does that.
    expect(row?.states).toEqual({});
  });

  it("leaves the switcher a key opened for the scene it was opened from, as a device's sleep does", async () => {
    const hub = await startHub();
    const { frame, privateKey, token } = await createFrame({ render_mode: "remote" });
    await db
      .update(frameServerRenders)
      .set({
        activeScene: "system/sceneSwitcher",
        states: { "system/sceneSwitcher": { from: "clock" } },
        // An open keyboard and an app's remembered value, which a device's
        // sleep forgets too.
        keptState: JSON.stringify({
          apps: [{ memory: { draft: "1" }, nodeId: 1, sceneId: "clock" }],
          targets: [{ focus: 1, keyboard: true, nodeId: 1, sceneId: "clock", text: "" }],
        }),
      })
      .where(eq(frameServerRenders.frameId, frame.id));
    const renderAt = Math.floor(Date.now() / 1000) + 2;
    await sleepFor(hub.port, token, privateKey, 2, renderAt);

    const outcome = await waitFor(() => outcomes.find((entry) => entry.frameId === frame.id), "pre-render");
    expect(outcome.outcome).toBe("kept");
    expect(renders[0]).toMatchObject({ frame: { pixelFormat: 1, rotate: 0 }, sceneId: "clock" });
    expect(renders[0]?.keptState).toBeUndefined();
    const [row] = await db.select().from(frameServerRenders).where(eq(frameServerRenders.frameId, frame.id));
    expect(row?.activeScene).toBe("clock");
    expect(row?.states).toEqual({});
    expect(row?.keptState).toBeNull();
    expect(row?.prerenderScene).toBe("clock");
  });

  it("shows the scene a key switched to on the plane, which the device's stale hello does not undo", async () => {
    const hub = await startHub();
    const { frame, linkedClient, privateKey, token } = await createFrame({ render_mode: "remote" });
    // RIGHT held: the plane's dispatcher ran it and the render ended on the
    // next scene.
    const pulled = await pullServerRender(db, {
      deviceInput: {
        edges: [],
        events: [
          { name: "gpio", origin: "driver", payload: { action: "down", atMs: 100, label: "RIGHT", level: 0, pin: 3 } },
          { name: "gpio", origin: "driver", payload: { action: "up", atMs: 900, label: "RIGHT", level: 1, pin: 3 } },
        ],
        nowMs: 1_000,
      },
      frame,
      linkedClient,
      panel: { format: 1, height: 480, rotate: 0, width: 800 },
      render: async (options) => ({ ...(await standIn(options)), sceneId: "weather" }),
    });
    expect(pulled.status).toBe(200);
    const lastState = async (frameId: string) =>
      (await db.select({ lastState: frames.lastState }).from(frames).where(eq(frames.id, frameId)))[0]?.lastState;
    expect(await lastState(frame.id)).toEqual({ active_scene: "weather", weather: { count: 7 } });

    // The device wakes and says hello with the scene its own runtime held
    // before it was switched to remote: the plane's word stands.
    await sleepFor(hub.port, token, privateKey, 600);
    expect(await lastState(frame.id)).toEqual({ active_scene: "weather", weather: { count: 7 } });

    // A frame that renders itself is the one to say.
    const local = await createFrame({});
    await sleepFor(hub.port, local.token, local.privateKey, 600);
    expect(await lastState(local.frame.id)).toEqual({ active_scene: "clock" });
  });

  it("is not drawn ahead when the frame renders itself", async () => {
    const hub = await startHub();
    const { privateKey, token } = await createFrame({});
    await sleepFor(hub.port, token, privateKey, 2);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(outcomes).toEqual([]);
    expect(renders).toEqual([]);
  });

  it("is left to the pull once the render time has passed", async () => {
    const hub = await startHub();
    const { privateKey, token } = await createFrame({ render_mode: "remote" });
    // A wake nearer than the lead is drawn at once, but a render time that
    // has already passed has nothing to be drawn ahead of.
    await sleepFor(hub.port, token, privateKey, 1, Math.floor(Date.now() / 1000) - 10);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(renders).toEqual([]);
  });
});
