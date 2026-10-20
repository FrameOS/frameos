// The sidecar end to end: the cloud's frame hub, unmodified, and the bridge the
// self-hosted backend drives it through, against a real Postgres built by the
// sidecar's own migration runner. A ws client plays the device the way the
// runtime does (frameos/src/frameos/cloud/hub_client.nim): Bearer link token,
// the raw nonce signed with its Ed25519 key, acks by id.
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createDb } from "@frameos-cloud/db";
import { hashSecret } from "../../../../auth-web/src/lib/secrets";
import { startFrameHub, type FrameHub } from "../../../../frame-hub/src/hub";
import { startBridge, type Bridge } from "../../bridge";

const secret = "backend-provider-integration-bridge-secret";
const db = createDb();
let hub: FrameHub;
let bridge: Bridge;

beforeEach(async () => {
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "schema_migrations")
    .map((name) => `"${name}"`);
  // The hub finishes a device message with an unawaited broadcast (reads on
  // frames / linked_clients); a TRUNCATE that collides with that tail is
  // picked as the deadlock victim (40P01). Retry it, as frame-hub's own suite
  // does (frame-hub.integration.test.ts truncateAllTables).
  for (let attempt = 1; names.length > 0; attempt++) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(", ")} CASCADE`));
      break;
    } catch (error) {
      let deadlock = false;
      for (let cursor: unknown = error; cursor && typeof cursor === "object"; cursor = (cursor as { cause?: unknown }).cause) {
        const { code, message } = cursor as { code?: string; message?: string };
        if (code === "40P01" || message?.includes("deadlock detected")) {
          deadlock = true;
          break;
        }
      }
      if (!deadlock || attempt >= 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  hub = await startFrameHub({ port: 0 });
  bridge = await startBridge({ port: 0, secret });
});

afterEach(async () => {
  await hub.close();
  await bridge.close();
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

async function call(method: string, path: string, body?: unknown, auth = secret) {
  const response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    method,
  });
  const text = await response.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { body: json as Record<string, unknown>, status: response.status };
}

interface Device {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  closed: Promise<number>;
  send(message: Record<string, unknown>): void;
  next(match: (message: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>>;
}

function newKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { privateKey, publicKey: Buffer.from(raw).toString("base64") };
}

async function registerFrame(backendFrameId: number, keys = newKeys()) {
  const token = `fb_link_${randomBytes(30).toString("base64url")}`;
  const response = await call("PUT", `/internal/frames/by-backend/${backendFrameId}`, {
    hardware: { device: "web_only", height: 480, platform: "buildroot", width: 800 },
    name: "Hall",
    project_id: 1,
    public_key: keys.publicKey,
    scopes: ["frame:managed", "settings:services", "telemetry:logs", "telemetry:metrics"],
    token_hash: hashSecret(token),
  });
  expect(response.status).toBe(200);
  return { frameId: String(response.body.frame_id), keys, token };
}

function openDevice(token: string): Promise<Device> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/api/frames/ws`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const messages: Record<string, unknown>[] = [];
    const waiters: { match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
    const closed = new Promise<number>((done) => ws.on("close", (code) => done(code)));
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      const waiter = waiters.find((w) => w.match(message));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        messages.push(message);
      }
    });
    ws.on("unexpected-response", (_request, response) => reject(new Error(`upgrade refused: ${response.statusCode}`)));
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        closed,
        messages,
        next(match, what) {
          const queued = messages.find(match);
          if (queued) {
            messages.splice(messages.indexOf(queued), 1);
            return Promise.resolve(queued);
          }
          return new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error(`timed out waiting for ${what}`)), 5000);
            waiters.push({
              match,
              resolve: (message) => {
                clearTimeout(timer);
                done(message);
              },
            });
          });
        },
        send(message) {
          ws.send(JSON.stringify(message));
        },
        ws,
      }),
    );
  });
}

async function connect(token: string, privateKey: KeyObject) {
  const device = await openDevice(token);
  const challenge = await device.next((m) => m.type === "challenge", "challenge");
  device.send({ frameos_version: "2026.10.18", hardware: { platform: "buildroot" }, scenes_checksum: "", states: {}, type: "hello" });
  const signature = sign(null, Buffer.from(String(challenge.nonce), "base64"), privateKey).toString("base64");
  device.send({ signature, type: "auth" });
  const ready = await device.next((m) => m.type === "ready", "ready");
  return { device, ready };
}

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the bridge", () => {
  it("answers only the backend that holds the secret", async () => {
    expect((await call("GET", "/internal/healthz", undefined, "wrong-secret-wrong-secret")).status).toBe(401);
    expect((await call("GET", "/internal/healthz")).status).toBe(200);
  });

  it("registers a frame the hub then lets in, and queues verbs the device receives", async () => {
    const { frameId, keys, token } = await registerFrame(7);
    expect((await call("GET", "/internal/frames/by-backend/7")).body.frame_id).toBe(frameId);
    const { device, ready } = await connect(token, keys.privateKey);
    expect(ready.pending_commands).toBe(0);
    expect(ready.scopes).toContain("telemetry:logs");

    const queued = await call("POST", `/internal/frames/${frameId}/commands`, { ttl_ms: 60_000, type: "render" });
    expect(queued.status).toBe(200);
    const verb = await device.next((m) => m.type === "render", "render verb");
    expect(verb.id).toBe(queued.body.id);
    device.send({ id: verb.id, ok: true, type: "ack" });
    await waitFor(async () => {
      const status = await call("GET", `/internal/frames/${frameId}/commands/${String(verb.id)}`);
      return status.body.status === "acked" ? status : undefined;
    }, "acked");

    // The backend's bookkeeping never reaches the queue or the device.
    const scenes = await call("POST", `/internal/frames/${frameId}/commands`, {
      payload: { _deploy: { id: "d1" }, checksum: "c1", scenes: [] },
      supersede: true,
      type: "set_scenes",
    });
    const pushed = await device.next((m) => m.type === "set_scenes", "set_scenes");
    expect(pushed).toEqual({ checksum: "c1", id: scenes.body.id, scenes: [], type: "set_scenes" });

    // The cloud's contract walker answers before anything is queued.
    const refused = await call("POST", `/internal/frames/${frameId}/commands`, {
      payload: { settings: { rotate: 45 } },
      type: "set_settings",
    });
    expect(refused).toEqual({ body: { error: "invalid_settings" }, status: 400 });
    expect((await call("POST", `/internal/frames/${frameId}/commands`, { type: "shell" })).body.error).toBe("unknown_verb");
    device.ws.close();
  });

  it("hands back the asset listing and the files the device sent", async () => {
    const { frameId, keys, token } = await registerFrame(8);
    const { device } = await connect(token, keys.privateKey);

    const list = await call("POST", `/internal/frames/${frameId}/commands`, { type: "assets_list" });
    const ask = await device.next((m) => m.type === "assets_list", "assets_list");
    device.send({ id: ask.id, ok: true, type: "ack" });
    device.send({ assets: [{ mtime: 1, path: "a.txt", size: 5 }], id: ask.id, type: "assets" });
    const listing = await waitFor(async () => {
      const response = await call("GET", `/internal/frames/${frameId}/assets`);
      return response.status === 200 ? response : undefined;
    }, "listing");
    expect(listing.body.assets).toEqual([{ mtime: 1, path: "a.txt", size: 5 }]);
    expect(list.status).toBe(200);

    await call("POST", `/internal/frames/${frameId}/commands`, { payload: { path: "a.txt" }, type: "asset_get" });
    const get = await device.next((m) => m.type === "asset_get", "asset_get");
    device.send({ id: get.id, ok: true, type: "ack" });
    device.send({
      content_type: "text/plain",
      data: Buffer.from("hello").toString("base64"),
      done: true,
      id: get.id,
      seq: 0,
      type: "asset_chunk",
    });
    const file = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/internal/frames/${frameId}/asset-file?path=a.txt`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      return response.status === 200 ? response : undefined;
    }, "asset file");
    expect(await file.text()).toBe("hello");
    expect(file.headers.get("x-updated-at")).toBeTruthy();
    device.ws.close();
  });

  it("closes a socket open under a replaced key, and a deleted frame's", async () => {
    const { frameId, keys, token } = await registerFrame(9);
    const first = await connect(token, keys.privateKey);
    const replacement = newKeys();
    await call("PUT", "/internal/frames/by-backend/9", {
      name: "Hall",
      public_key: replacement.publicKey,
      scopes: ["frame:managed"],
      token_hash: hashSecret(token),
    });
    expect(await first.device.closed).toBe(4401);

    const second = await connect(token, replacement.privateKey);
    expect((await call("DELETE", `/internal/frames/${frameId}`)).status).toBe(200);
    expect(await second.device.closed).toBe(4401);
    expect((await call("GET", `/internal/frames/${frameId}`)).status).toBe(404);
  });

  it("mints a session that follows the frames on the hub's fleet socket", async () => {
    const { frameId, keys, token } = await registerFrame(10);
    const session = await call("POST", "/internal/session");
    const browser = new WebSocket(`ws://127.0.0.1:${hub.port}/api/frames/updates`, {
      headers: { cookie: String(session.body.cookie) },
    });
    const events: Record<string, unknown>[] = [];
    browser.on("message", (data) => events.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise((resolve, reject) => {
      browser.on("open", resolve);
      browser.on("unexpected-response", (_request, response) => reject(new Error(`refused: ${response.statusCode}`)));
    });
    const { device } = await connect(token, keys.privateKey);
    device.send({ id: "4b6f7a2e-0000-4000-8000-000000000001", states: { active_scene: "clock" }, type: "state" });
    const update = await waitFor(async () => {
      const found = events.find((event) => {
        const data = event.data as Record<string, unknown> | undefined;
        const state = data?.last_state as Record<string, unknown> | undefined;
        return event.event === "update_frame" && data?.id === frameId && state?.active_scene === "clock";
      });
      return found;
    }, "update_frame");
    expect((update.data as Record<string, unknown>).connected).toBe(true);
    device.ws.close();
    browser.close();
  });
});
