// Virtual frames end to end on the hub: a real Postgres, the real session
// machinery, and a stand-in for the wasm runtime (docs/cloud-frames.md
// "Virtual frames"). The device under test is the one production runs; only
// what it draws is faked.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accounts,
  createDb,
  frameAssetFiles,
  frameCommands,
  frameLogs,
  frames,
  linkedClients,
  virtualFrames,
} from "@frameos-cloud/db";
import { readBlob } from "../../../../auth-web/src/lib/blobs";
import { sceneSnapshotAssetPath } from "../../../../auth-web/src/lib/frame-asset-cache";
import {
  enqueueFrameCommand,
  frameImageAssetPath,
  frameManagedScope,
  frameTelemetryLogsScope,
  revokeFrame,
} from "../../../../auth-web/src/lib/frames";
import {
  encodePng,
  rendererAvailable,
  renderScenes,
  SceneRenderError,
  setWasmAssetsDir,
  type SceneRenderOptions,
  type SceneRenderResult,
} from "../../../../auth-web/src/lib/scene-render";
import { hashSecret } from "../../../../auth-web/src/lib/secrets";
import {
  newVirtualViewToken,
  notifyVirtualFrame,
  virtualHardware,
} from "../../../../auth-web/src/lib/virtual-frames";
import { startFrameHub, type FrameHub, type FrameHubOptions } from "../../hub";
import { VirtualDevice } from "../../virtual-device";

const db = createDb();
const hubs: FrameHub[] = [];
// Every render the stand-in was asked for, and what it answers next.
let renders: SceneRenderOptions[] = [];
let renderAnswer: (options: SceneRenderOptions) => SceneRenderResult | Promise<SceneRenderResult>;

function picture(options: SceneRenderOptions, shade = 0): SceneRenderResult {
  const rgba = new Uint8Array(options.width * options.height * 4).fill(shade);
  return {
    errors: [],
    height: options.height,
    logs: [JSON.stringify({ event: "render:app", name: "color" }), "plain text line"],
    png: encodePng(rgba, options.width, options.height),
    renderMs: 7,
    state: { count: 1, hidden: "kept out", refreshInterval: 600 },
    thumbnail: encodePng(new Uint8Array(4 * 4 * 4).fill(shade), 4, 4),
    width: options.width,
  };
}

async function startHub(options: Partial<FrameHubOptions> = {}) {
  const hub = await startFrameHub({
    port: 0,
    // Only the passes a test asks for.
    virtualTickIntervalMs: 3_600_000,
    virtualRender: async (render) => {
      renders.push(render);
      return await renderAnswer(render);
    },
    ...options,
  });
  hubs.push(hub);
  return hub;
}

beforeEach(async () => {
  renders = [];
  renderAnswer = (options) => picture(options);
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

async function waitFor<T>(probe: () => Promise<T | undefined>, label: string, timeoutMs = 10_000): Promise<T> {
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

const scopes = [frameManagedScope, frameTelemetryLogsScope];

async function createLink(accountId: string) {
  const { publicKey } = generateKeyPairSync("ed25519");
  const [linkedClient] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: scopes },
      publicDisplayName: "Lobby",
      tokenReference: hashSecret(`fc_link_${randomBytes(24).toString("base64url")}`),
    })
    .returning();
  return {
    linkedClient: linkedClient!,
    publicKey: Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url").toString("base64"),
  };
}

// What auth-web's createVirtualFrame writes, without the plan it reads.
async function createVirtualFixture(options: { width?: number; height?: number } = {}) {
  const [account] = await db.insert(accounts).values({ displayName: "Virtual Tester" }).returning();
  const { linkedClient, publicKey } = await createLink(account!.id);
  const [frame] = await db
    .insert(frames)
    .values({
      accountId: account!.id,
      hardware: virtualHardware(options.width ?? 32, options.height ?? 16),
      linkedClientId: linkedClient.id,
      name: "Lobby",
      publicKey,
      status: "active",
    })
    .returning();
  await db.insert(virtualFrames).values({ frameId: frame!.id, viewToken: newVirtualViewToken() });
  return { account: account!, frame: frame!, linkedClient };
}

const scenes = [
  {
    fields: [
      { name: "count", type: "integer" },
      { access: "private", name: "hidden", type: "string" },
    ],
    id: "clock",
    nodes: [],
    settings: { refreshInterval: 900 },
  },
  { customEvents: [{ name: "nextPage", origins: ["cloud"] }], id: "news", nodes: [] },
];

async function frameRow(frameId: string) {
  const [row] = await db.select().from(frames).where(eq(frames.id, frameId)).limit(1);
  return row!;
}

async function virtualRow(frameId: string) {
  const [row] = await db.select().from(virtualFrames).where(eq(virtualFrames.frameId, frameId)).limit(1);
  return row!;
}

async function commandRow(commandId: string) {
  const [row] = await db.select().from(frameCommands).where(eq(frameCommands.id, commandId)).limit(1);
  return row!;
}

async function connected(frameId: string) {
  return await waitFor(async () => ((await frameRow(frameId)).connected ? true : undefined), "the virtual device");
}

async function settled(commandId: string) {
  return await waitFor(async () => {
    const row = await commandRow(commandId);
    return row.status === "acked" || row.status === "failed" ? row : undefined;
  }, "the command's ack");
}

async function push(frameId: string, payload: Record<string, unknown>) {
  const command = await enqueueFrameCommand(db, { frameId, payload, type: "set_scenes" });
  return command!;
}

async function imageBytes(frameId: string, path = frameImageAssetPath, thumb = false) {
  const [row] = await db
    .select()
    .from(frameAssetFiles)
    .where(and(eq(frameAssetFiles.frameId, frameId), eq(frameAssetFiles.path, path), eq(frameAssetFiles.thumb, thumb)))
    .limit(1);
  return row ? await readBlob(row) : undefined;
}

describe("a virtual frame's device", () => {
  it("comes up with the hub and reports what the row says", async () => {
    const { frame } = await createVirtualFixture({ height: 48, width: 80 });
    const hub = await startHub();
    await connected(frame.id);
    expect(hub.connectedFrames()).toBe(1);
    const row = await frameRow(frame.id);
    expect(row.hardware).toMatchObject({ device: "virtual", height: 48, platform: "virtual", width: 80 });
    // Nothing to draw yet: no render, no picture.
    expect(renders).toHaveLength(0);
  });

  it("starts for a frame created while the hub runs", async () => {
    await startHub();
    const { frame } = await createVirtualFixture();
    await notifyVirtualFrame(db, frame.id);
    await connected(frame.id);
  });

  it("never runs for hardware that only says it is virtual", async () => {
    const [account] = await db.insert(accounts).values({ displayName: "Pretender" }).returning();
    const { linkedClient, publicKey } = await createLink(account!.id);
    const [frame] = await db
      .insert(frames)
      .values({
        accountId: account!.id,
        hardware: { platform: "virtual" },
        linkedClientId: linkedClient.id,
        name: "Pretender",
        publicKey,
        status: "active",
      })
      .returning();
    const hub = await startHub();
    await notifyVirtualFrame(db, frame!.id);
    await hub.virtualTick();
    expect(hub.connectedFrames()).toBe(0);
    expect((await frameRow(frame!.id)).connected).toBe(false);
  });

  it("applies a scene push, draws it and reports back like a frame", async () => {
    const { account, frame } = await createVirtualFixture();
    await startHub();
    await connected(frame.id);

    const command = await push(frame.id, { checksum: "sum-1", scene_id: "clock", scenes, state: { count: 5, hidden: "no" } });
    expect((await settled(command.id)).status).toBe("acked");
    await waitFor(async () => ((await virtualRow(frame.id)).renderedAt ? true : undefined), "the first render");

    // Rendered at the frame's size, as its owner, with the pushed state — a
    // private field is not settable from outside.
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({ height: 16, owner: account.id, sceneId: "clock", width: 32 });
    expect(renders[0]!.states).toEqual({ clock: { count: 5 } });
    expect(renders[0]!.scenes).toEqual(scenes);

    const virtual = await virtualRow(frame.id);
    expect(virtual.scenesChecksum).toBe("sum-1");
    expect(virtual.activeScene).toBe("clock");
    // What the render reported is the scene's memory for the next one: its
    // public fields and its interval, not a private one.
    expect(virtual.states).toEqual({ clock: { count: 1, refreshInterval: 600 } });
    expect(virtual.refreshSeconds).toBe(600);
    expect(virtual.renderError).toBeNull();
    expect(virtual.imageVersion).toMatch(/^[0-9a-f]{32}$/);

    // The picture is the frame's image and the scene's snapshot.
    const expected = picture(renders[0]!).png;
    expect(await imageBytes(frame.id)).toEqual(expected);
    expect(await imageBytes(frame.id, sceneSnapshotAssetPath("clock"))).toEqual(expected);
    expect((await imageBytes(frame.id, sceneSnapshotAssetPath("clock"), true))!.length).toBeLessThan(expected.length);

    // And the hub heard it the way it hears hardware.
    const row = await waitFor(async () => {
      const current = await frameRow(frame.id);
      return current.scenesChecksum === "sum-1" && current.lastState ? current : undefined;
    }, "the scene_ack and the state");
    expect(row.lastState).toMatchObject({ active_scene: "clock", clock: { count: 1 } });
    const logs = await waitFor(async () => {
      const rows = await db.select().from(frameLogs).where(eq(frameLogs.frameId, frame.id)).orderBy(asc(frameLogs.id));
      return rows.length >= 4 ? rows : undefined;
    }, "the render's log lines");
    expect(logs.map((log) => (log.payload as { event?: string }).event ?? log.payload)).toEqual([
      "render:scene",
      "render:app",
      "plain text line",
      "render:done",
    ]);
    // The deploy's bar ran to its end.
    await waitFor(async () => {
      const progress = (await frameRow(frame.id)).deployProgress as { status?: string } | null;
      return progress?.status === "done" ? true : undefined;
    }, "the deploy to finish");
  });

  it("switches scenes, keeps state between renders and hands events to the scene", async () => {
    const { frame } = await createVirtualFixture();
    await startHub();
    await connected(frame.id);
    await settled((await push(frame.id, { checksum: "sum-1", scenes })).id);
    await waitFor(async () => (renders.length === 1 ? true : undefined), "the first render");
    // No scene named: the first of the push.
    expect(renders[0]!.sceneId).toBe("clock");

    const unknown = await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { scene_id: "nowhere" },
      type: "set_current_scene",
    });
    expect(await settled(unknown!.id)).toMatchObject({ error: "scene_not_found", status: "failed" });

    const change = await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { scene_id: "news" },
      type: "set_current_scene",
    });
    expect((await settled(change!.id)).status).toBe("acked");
    await waitFor(async () => (renders.length === 2 ? true : undefined), "the render after the switch");
    expect(renders[1]!.sceneId).toBe("news");
    // The clock's state from its render is still there for when it returns.
    expect(renders[1]!.states).toMatchObject({ clock: { count: 1 } });

    const event = await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { name: "nextPage", payload: { step: 2 } },
      type: "scene_event",
    });
    expect((await settled(event!.id)).status).toBe("acked");
    await waitFor(async () => (renders.length === 3 ? true : undefined), "the render that delivers the event");
    expect(renders[2]!.events).toEqual([{ name: "nextPage", origin: "cloud", payload: { step: 2 } }]);

    const state = await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { name: "setSceneState", payload: { state: { refreshInterval: 1200 } } },
      type: "scene_event",
    });
    expect((await settled(state!.id)).status).toBe("acked");
    await waitFor(async () => (renders.length === 4 ? true : undefined), "the render after the state change");
    expect(renders[3]!.events).toEqual([]);
    expect((renders[3]!.states as Record<string, unknown>).news).toMatchObject({ refreshInterval: 1200 });
  });

  it("answers what a device answers, and refuses what it has no body for", async () => {
    const { frame } = await createVirtualFixture();
    await startHub();
    await connected(frame.id);

    const early = await enqueueFrameCommand(db, { frameId: frame.id, type: "image_get" });
    expect(await settled(early!.id)).toMatchObject({ error: "no_image", status: "failed" });

    await settled((await push(frame.id, { checksum: "sum-1", scenes })).id);
    await waitFor(async () => (renders.length === 1 ? true : undefined), "the first render");
    const stored = await waitFor(async () => {
      const [row] = await db
        .select({ updatedAt: frameAssetFiles.updatedAt })
        .from(frameAssetFiles)
        .where(and(eq(frameAssetFiles.frameId, frame.id), eq(frameAssetFiles.path, frameImageAssetPath)))
        .limit(1);
      return row;
    }, "the picture");

    // image_get streams the picture back through the hub's own cache write,
    // which is what the workspace's refresh waits for.
    const image = await enqueueFrameCommand(db, { frameId: frame.id, type: "image_get" });
    expect((await settled(image!.id)).status).toBe("acked");
    await waitFor(async () => {
      const [row] = await db
        .select({ updatedAt: frameAssetFiles.updatedAt })
        .from(frameAssetFiles)
        .where(and(eq(frameAssetFiles.frameId, frame.id), eq(frameAssetFiles.path, frameImageAssetPath)))
        .limit(1);
      return row && row.updatedAt.getTime() > stored.updatedAt.getTime() ? true : undefined;
    }, "the cache write of the image_get reply");

    for (const [type, payload, error] of [
      ["set_display_power", { on: false }, "unsupported_verb"],
      ["asset_put", { data: "aGk=", path: "a.txt" }, "unsupported_verb"],
      ["asset_get", { path: "photos/a.jpg" }, "not_found"],
      ["asset_get", { path: "../etc/passwd" }, "invalid_path"],
      ["made_up", {}, "unknown_verb"],
    ] as const) {
      const command = await enqueueFrameCommand(db, { frameId: frame.id, payload, type });
      expect(await settled(command!.id), type).toMatchObject({ error, status: "failed" });
    }
    const render = await enqueueFrameCommand(db, { frameId: frame.id, type: "render" });
    expect((await settled(render!.id)).status).toBe("acked");
    await waitFor(async () => (renders.length === 2 ? true : undefined), "the render that was asked for");
  });

  it("keeps the last picture and says why when a render fails", async () => {
    const { frame } = await createVirtualFixture();
    await startHub();
    await connected(frame.id);
    await settled((await push(frame.id, { checksum: "sum-1", scenes })).id);
    await waitFor(async () => (renders.length === 1 ? true : undefined), "the first render");
    const before = await waitFor(async () => await imageBytes(frame.id), "the picture");

    renderAnswer = () => {
      throw new SceneRenderError("render_timeout", "The scene did not render within 30s.", ["last words"]);
    };
    const render = await enqueueFrameCommand(db, { frameId: frame.id, type: "render" });
    await settled(render!.id);
    const failed = await waitFor(async () => {
      const row = await virtualRow(frame.id);
      return row.renderError ? row : undefined;
    }, "the failure on the row");
    expect(failed.renderError).toBe("render_timeout: The scene did not render within 30s.");
    expect(await imageBytes(frame.id)).toEqual(before);
    await waitFor(async () => {
      const rows = await db.select().from(frameLogs).where(eq(frameLogs.frameId, frame.id));
      return rows.some((row) => (row.payload as { event?: string }).event === "render:error") ? true : undefined;
    }, "the error in the frame's log");
  });

  it("draws at a new size, and a render already running does not put the old one back", async () => {
    const { frame } = await createVirtualFixture({ height: 16, width: 32 });
    await startHub();
    await connected(frame.id);
    // The first render hangs until the test lets it go.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAnswer = async (options) => {
      if (renders.length === 1) {
        await held;
      }
      return picture(options);
    };
    await settled((await push(frame.id, { checksum: "sum-1", scenes })).id);
    await waitFor(async () => (renders.length === 1 ? true : undefined), "the render to start");

    // What POST /api/frames/{id}/virtual does: the row, then the notify.
    await db.update(frames).set({ hardware: virtualHardware(48, 24) }).where(eq(frames.id, frame.id));
    await notifyVirtualFrame(db, frame.id);
    release!();

    await waitFor(async () => (renders.length === 2 ? true : undefined), "the render at the new size");
    expect(renders[0]).toMatchObject({ height: 16, width: 32 });
    expect(renders[1]).toMatchObject({ height: 24, width: 48 });
    const png = await waitFor(async () => {
      const bytes = await imageBytes(frame.id);
      return bytes && bytes.readUInt32BE(16) === 48 ? bytes : undefined;
    }, "the picture at the new size");
    expect(png.readUInt32BE(20)).toBe(24);
    // Whatever the device said on the way, the size is still the owner's.
    expect((await frameRow(frame.id)).hardware).toMatchObject({ height: 24, width: 48 });
  });

  it("comes back and draws again when it is told to restart", async () => {
    const { frame } = await createVirtualFixture();
    const hub = await startHub();
    await connected(frame.id);
    await settled((await push(frame.id, { checksum: "sum-1", scenes })).id);
    await waitFor(async () => (renders.length === 1 ? true : undefined), "the first render");
    const before = (await frameRow(frame.id)).hubSessionId;

    // What the telemetry switch queues after it changes the link's scopes.
    const restart = await enqueueFrameCommand(db, { frameId: frame.id, type: "restart_runtime" });
    expect((await settled(restart!.id)).status).toBe("acked");
    await waitFor(async () => {
      const row = await frameRow(frame.id);
      return row.connected && row.hubSessionId !== before ? true : undefined;
    }, "the new session");
    await waitFor(async () => (renders.length === 2 ? true : undefined), "the render after the restart");
    expect(hub.connectedFrames()).toBe(1);
    // The restart's bar: back, drawn, done.
    await waitFor(async () => {
      const progress = (await frameRow(frame.id)).deployProgress as { kind?: string; status?: string } | null;
      return progress?.kind === "restart" && progress.status === "done" ? true : undefined;
    }, "the restart to finish");
  });

  it("goes away with its frame", async () => {
    const { frame } = await createVirtualFixture();
    const hub = await startHub();
    await connected(frame.id);
    await revokeFrame(db, frame);
    await waitFor(async () => (hub.connectedFrames() === 0 ? true : undefined), "the session to be kicked");
    expect((await frameRow(frame.id)).connected).toBe(false);
    // And a later pass does not bring it back.
    await hub.virtualTick();
    expect(hub.connectedFrames()).toBe(0);
  });
});

describe("rendering on the interval", () => {
  async function withScenes(hubOptions: Partial<FrameHubOptions> = {}) {
    const fixture = await createVirtualFixture();
    const hub = await startHub(hubOptions);
    await connected(fixture.frame.id);
    await settled((await push(fixture.frame.id, { checksum: "sum-1", scenes: [scenes[1]] })).id);
    await waitFor(async () => (renders.length === 1 ? true : undefined), "the first render");
    await waitFor(async () => ((await virtualRow(fixture.frame.id)).renderedAt ? true : undefined), "the row");
    return { ...fixture, hub };
  }

  async function renderedSecondsAgo(frameId: string, seconds: number) {
    await db
      .update(virtualFrames)
      .set({ renderedAt: new Date(Date.now() - seconds * 1000) })
      .where(eq(virtualFrames.frameId, frameId));
  }

  it("does not draw a picture nobody is looking at", async () => {
    const { frame, hub } = await withScenes({ virtualMinIntervalSeconds: 300 });
    await renderedSecondsAgo(frame.id, 86_400);
    await hub.virtualTick();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(renders).toHaveLength(1);
  });

  it("draws again once the interval has passed while someone looks", async () => {
    const { frame, hub } = await withScenes({ virtualMinIntervalSeconds: 300 });
    const looking = { viewedAt: new Date() };
    await db.update(virtualFrames).set(looking).where(eq(virtualFrames.frameId, frame.id));
    async function passes(secondsAgo: number, expected: number, label: string) {
      await renderedSecondsAgo(frame.id, secondsAgo);
      await hub.virtualTick();
      if (expected > renders.length) {
        await waitFor(async () => (renders.length === expected ? true : undefined), label);
        await waitFor(
          async () => (Date.now() - (await virtualRow(frame.id)).renderedAt!.getTime() < 5_000 ? true : undefined),
          "the row after that render",
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(renders, label).toHaveLength(expected);
      }
    }

    // The scene asked for ten minutes (its render said refreshInterval 600).
    expect((await virtualRow(frame.id)).refreshSeconds).toBe(600);
    await passes(400, 1, "the scene's own interval has not passed");
    await passes(601, 2, "the render on the scene's interval");

    // A frame that asks for less than the plan's floor gets the floor.
    await db.update(frames).set({ settings: { interval: 10 } }).where(eq(frames.id, frame.id));
    await db.update(virtualFrames).set({ refreshSeconds: null }).where(eq(virtualFrames.frameId, frame.id));
    await passes(200, 2, "under the floor");
    await db.update(virtualFrames).set({ refreshSeconds: null }).where(eq(virtualFrames.frameId, frame.id));
    await passes(301, 3, "the render at the floor");

    // A workspace page open on the frame counts as looking too, and the
    // frame's own interval holds when it is over the floor.
    await db
      .update(virtualFrames)
      .set({ refreshSeconds: null, viewedAt: null })
      .where(eq(virtualFrames.frameId, frame.id));
    await db
      .update(frames)
      .set({ previewWatchedAt: new Date(), settings: { interval: 900 } })
      .where(eq(frames.id, frame.id));
    await passes(600, 3, "the frame's interval has not passed");
    await db.update(virtualFrames).set({ refreshSeconds: null }).where(eq(virtualFrames.frameId, frame.id));
    await passes(901, 4, "the render on the frame's interval");
  });

  it("paces a scene that cannot render by the interval too", async () => {
    const { frame, hub } = await withScenes({ virtualMinIntervalSeconds: 300 });
    await db.update(virtualFrames).set({ viewedAt: new Date() }).where(eq(virtualFrames.frameId, frame.id));
    renderAnswer = () => {
      throw new SceneRenderError("render_failed", "boom");
    };
    await renderedSecondsAgo(frame.id, 700);
    await hub.virtualTick();
    await waitFor(async () => ((await virtualRow(frame.id)).renderError ? true : undefined), "the failure");
    expect(renders).toHaveLength(2);
    // The failure moved rendered_at: the next pass leaves it alone.
    await hub.virtualTick();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(renders).toHaveLength(2);
  });
});

describe("the schedule", () => {
  it("fires an entry in the frame's own time zone, once", async () => {
    const { frame } = await createVirtualFixture();
    await db
      .update(virtualFrames)
      .set({ activeScene: "clock", scenes, scenesChecksum: "sum-1" })
      .where(eq(virtualFrames.frameId, frame.id));
    await db
      .update(frames)
      .set({
        schedule: {
          events: [
            // 08:30 in Tallinn on weekdays; the 3rd of November 2026 is a Tuesday.
            { event: "setCurrentScene", hour: 8, id: "a", minute: 30, payload: { sceneId: "news" }, weekday: 8 },
            { disabled: true, event: "setCurrentScene", hour: 8, id: "b", minute: 30, payload: { sceneId: "clock" }, weekday: 0 },
          ],
        },
        settings: { timezone: "Europe/Tallinn" },
      })
      .where(eq(frames.id, frame.id));

    const start = new Date("2026-11-03T06:29:10Z");
    const device = new VirtualDevice(
      {
        db,
        deliver: () => undefined,
        frameId: frame.id,
        render: async (options) => {
          renders.push(options);
          return picture(options);
        },
        rendererVersion: () => "2026.11.2",
        restart: () => undefined,
      },
      start.getTime(),
    );
    // The same minute: nothing. The next one is 08:30 local.
    await device.runSchedule(new Date("2026-11-03T06:29:50Z"));
    expect(renders).toHaveLength(0);
    await device.runSchedule(new Date("2026-11-03T06:30:05Z"));
    await waitFor(async () => (renders.length === 1 ? true : undefined), "the scheduled switch");
    expect(renders[0]!.sceneId).toBe("news");
    expect(renders[0]!.timeZone).toBe("Europe/Tallinn");
    // Asked again within the minute, and a minute later: it fired once.
    await device.runSchedule(new Date("2026-11-03T06:30:40Z"));
    await device.runSchedule(new Date("2026-11-03T06:31:05Z"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(renders).toHaveLength(1);
    device.close();
  });
});

// The one test with nothing faked: the hub's device, the wasm runtime
// auth-web ships, a scene drawn to a PNG. Skipped on a checkout that has not
// installed the runtime (auth-web's predev / prebuild does), like auth-web's
// own render test.
if (!process.env.FRAMEOS_WASM_DIR) {
  setWasmAssetsDir(path.resolve(process.cwd(), "..", "auth-web", "public", "frameos-wasm"));
}

describe.skipIf(!rendererAvailable())("with the real runtime", () => {
  it("draws a pushed scene at the frame's size", async () => {
    const { frame } = await createVirtualFixture({ height: 120, width: 200 });
    await startHub({ virtualRender: renderScenes });
    await connected(frame.id);
    const scene = {
      edges: [],
      fields: [{ access: "public", name: "text", type: "string", value: "hi" }],
      id: "blank",
      name: "Blank",
      nodes: [{ data: { keyword: "render" }, id: "e1", position: { x: 0, y: 0 }, type: "event" }],
      settings: { backgroundColor: "#336699", execution: "interpreted", refreshInterval: 1800 },
    };
    await settled((await push(frame.id, { checksum: "real-1", scenes: [scene], state: { text: "seeded" } })).id);
    const virtual = await waitFor(
      async () => {
        const row = await virtualRow(frame.id);
        return row.renderedAt ? row : undefined;
      },
      "the runtime's render",
      60_000,
    );
    expect(virtual.renderError).toBeNull();
    expect(virtual.states).toMatchObject({ blank: { text: "seeded" } });
    // The scene's own interval, read from what the runtime reported.
    expect(virtual.refreshSeconds).toBe(1800);
    const png = (await imageBytes(frame.id))!;
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(200);
    expect(png.readUInt32BE(20)).toBe(120);
    const thumb = (await imageBytes(frame.id, sceneSnapshotAssetPath("blank"), true))!;
    expect(thumb.readUInt32BE(16)).toBe(200);
  }, 90_000);
});
