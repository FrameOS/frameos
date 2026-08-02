// Full-stack hub tests: a real HTTP+WebSocket server, a real Postgres, real
// ws clients playing the device and the browser. Wire contract:
// docs/cloud-frames.md at the repo root.
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  accounts,
  createDb,
  frameCommands,
  frameLogs,
  frames,
  linkedClients,
  sessions,
} from "@frameos-cloud/db";
import {
  enqueueFrameCommand,
  frameManagedScope,
  frameTelemetryLogsScope,
  frameTelemetryMetricsScope,
  maxLogBatch,
  revokeFrame,
} from "../../../../auth-web/src/lib/frames";
import { derivedSigningKey } from "../../../../auth-web/src/lib/keys";
import { hashSecret } from "../../../../auth-web/src/lib/secrets";
import { startFrameHub, type FrameHub } from "../../hub";

const db = createDb();
let hub: FrameHub;

beforeEach(async () => {
  await truncateAllTables();
  hub = await startFrameHub({ port: 0 });
});

afterEach(async () => {
  await hub.close();
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

async function truncateAllTables() {
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
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// --- fixtures -------------------------------------------------------------

function rawPublicKeyBase64(publicKey: KeyObject) {
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.from(String(jwk.x), "base64url").toString("base64");
}

const allScopes = [
  frameManagedScope,
  frameTelemetryLogsScope,
  frameTelemetryMetricsScope,
];

async function createFrameFixture(scopes: string[] = allScopes) {
  const [account] = await db
    .insert(accounts)
    .values({ displayName: "Hub Tester" })
    .returning();
  if (!account) {
    throw new Error("account insert failed");
  }
  return { account, ...(await createFrameForAccount(account.id, scopes)) };
}

async function createFrameForAccount(
  accountId: string,
  scopes: string[] = allScopes,
) {
  const token = `fc_link_${randomBytes(24).toString("base64url")}`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const [linkedClient] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: scopes },
      publicDisplayName: "Hub test frame",
      tokenReference: hashSecret(token),
    })
    .returning();
  if (!linkedClient) {
    throw new Error("linked client insert failed");
  }
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: linkedClient.id,
      name: "Hub test frame",
      publicKey: rawPublicKeyBase64(publicKey),
      status: "active",
    })
    .returning();
  if (!frame) {
    throw new Error("frame insert failed");
  }
  return { frame, linkedClient, privateKey, token };
}

async function createBrowserSession(accountId: string) {
  const token = await new SignJWT({ profile: { accountId } })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(derivedSigningKey("session"));
  await db.insert(sessions).values({
    accountId,
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    tokenHash: hashSecret(token),
  });
  return token;
}

// --- ws client harness ----------------------------------------------------

interface TestSocket {
  ws: WebSocket;
  send(message: Record<string, unknown>): void;
  sendRaw(message: string): void;
  next(
    match: (msg: Record<string, unknown>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  closed: Promise<number>;
}

function openSocket(
  path: string,
  headers: Record<string, string>,
): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}${path}`, { headers });
    const buffered: Record<string, unknown>[] = [];
    const waiters: {
      match: (msg: Record<string, unknown>) => boolean;
      resolve: (msg: Record<string, unknown>) => void;
    }[] = [];
    let closeCode = 0;
    const closed = new Promise<number>((resolveClosed) => {
      ws.on("close", (code) => {
        closeCode = code;
        resolveClosed(code);
      });
    });

    ws.on("message", (data) => {
      const parsed: unknown = JSON.parse(String(data));
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      const msg = parsed as Record<string, unknown>;
      const index = waiters.findIndex((waiter) => waiter.match(msg));
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        waiter?.resolve(msg);
      } else {
        buffered.push(msg);
      }
    });

    ws.once("error", reject);
    ws.once("open", () => {
      ws.removeListener("error", reject);
      resolve({
        closed,
        next(match, label, timeoutMs = 10_000) {
          const index = buffered.findIndex(match);
          if (index >= 0) {
            const [msg] = buffered.splice(index, 1);
            return Promise.resolve(msg as Record<string, unknown>);
          }
          return new Promise((resolveNext, rejectNext) => {
            const timer = setTimeout(
              () =>
                rejectNext(
                  new Error(
                    `Timed out waiting for ${label} (close code ${closeCode})`,
                  ),
                ),
              timeoutMs,
            );
            waiters.push({
              match,
              resolve: (msg) => {
                clearTimeout(timer);
                resolveNext(msg);
              },
            });
          });
        },
        send: (message) => ws.send(JSON.stringify(message)),
        sendRaw: (message) => ws.send(message),
        ws,
      });
    });
  });
}

function expectUpgradeRejected(
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}${path}`, { headers });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => reject(new Error("upgrade unexpectedly succeeded")));
    ws.on("error", () => undefined);
  });
}

function openDevice(token: string) {
  return openSocket("/api/frames/ws", { authorization: `Bearer ${token}` });
}

function openBrowser(frameId: string, sessionToken: string) {
  return openSocket(`/api/frames/${frameId}/updates`, {
    cookie: `frameos_cloud_session=${sessionToken}`,
  });
}

function openFleetBrowser(sessionToken: string) {
  return openSocket("/api/frames/updates", {
    cookie: `frameos_cloud_session=${sessionToken}`,
  });
}

async function handshake(
  socket: TestSocket,
  privateKey: KeyObject,
  hello: Record<string, unknown> = {},
) {
  const challenge = await socket.next(
    (msg) => msg.type === "challenge",
    "challenge",
  );
  const nonce = Buffer.from(String(challenge.nonce), "base64");
  expect(nonce.length).toBeGreaterThanOrEqual(32);
  socket.send({
    frameos_version: "2026.8.1",
    hardware: { platform: "pi-zero2w" },
    id: randomUUID(),
    scenes_checksum: "sum-hello",
    states: { active_scene: "boot" },
    type: "hello",
    ...hello,
  });
  socket.send({
    id: randomUUID(),
    signature: sign(null, nonce, privateKey).toString("base64"),
    type: "auth",
  });
  return socket.next((msg) => msg.type === "ready", "ready");
}

// --- tests ----------------------------------------------------------------

describe("device socket", () => {
  it("authenticates, reports state, and drains the command queue in order", async () => {
    const { frame, privateKey, token } = await createFrameFixture();

    // Two pending commands queued before connect (oldest first), plus one
    // whose TTL already passed and must never be delivered.
    await db.insert(frameCommands).values([
      {
        createdAt: new Date(Date.now() - 3000),
        frameId: frame.id,
        payload: { scene_id: "scene-a" },
        type: "set_current_scene",
      },
      {
        createdAt: new Date(Date.now() - 2000),
        frameId: frame.id,
        payload: null,
        type: "render",
      },
      {
        createdAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() - 500),
        frameId: frame.id,
        payload: null,
        type: "reboot",
      },
    ]);

    const device = await openDevice(token);
    const ready = await handshake(device, privateKey);
    expect(ready.pending_commands).toBe(2);

    const first = await device.next(
      (msg) => msg.type === "set_current_scene",
      "first command",
    );
    expect(first.scene_id).toBe("scene-a");
    const second = await device.next(
      (msg) => msg.type === "render",
      "second command",
    );

    // hello updated the frames row.
    const connected = await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frame.id));
      return row?.connected ? row : undefined;
    }, "frame marked connected");
    expect(connected.frameosVersion).toBe("2026.8.1");
    expect(connected.scenesChecksum).toBe("sum-hello");
    expect(connected.lastState).toEqual({ active_scene: "boot" });
    expect(connected.hubSessionId).toBeTruthy();
    expect(connected.lastSeenAt).toBeTruthy();

    // The expired command was marked, not sent.
    const [expired] = await db
      .select()
      .from(frameCommands)
      .where(
        and(eq(frameCommands.frameId, frame.id), eq(frameCommands.type, "reboot")),
      );
    expect(expired?.status).toBe("expired");

    // Acks: ok=true → acked, ok=false → failed with the error retained.
    device.send({ id: first.id, ok: true, type: "ack" });
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frameCommands)
        .where(eq(frameCommands.id, String(first.id)));
      return row?.status === "acked" ? row : undefined;
    }, "first command acked");
    device.send({ error: "display busy", id: second.id, ok: false, type: "ack" });
    const failed = await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frameCommands)
        .where(eq(frameCommands.id, String(second.id)));
      return row?.status === "failed" ? row : undefined;
    }, "second command failed");
    expect(failed.error).toBe("display busy");

    // A command enqueued while connected arrives via LISTEN/NOTIFY without
    // any reconnect or sweep.
    const enqueued = await enqueueFrameCommand(db, {
      frameId: frame.id,
      type: "render",
      ttlMs: 60_000,
    });
    const live = await device.next(
      (msg) => msg.type === "render" && msg.id === enqueued?.id,
      "notified command",
    );
    expect(live.id).toBe(enqueued?.id);
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frameCommands)
        .where(eq(frameCommands.id, String(enqueued?.id)));
      return row?.status === "sent" ? row : undefined;
    }, "notified command marked sent");

    // Health endpoint counts the live device socket.
    const health = await fetch(`http://127.0.0.1:${hub.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ connected_frames: 1 });

    // Disconnect flips connected back off.
    device.ws.close();
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frame.id));
      return row && !row.connected ? row : undefined;
    }, "frame marked disconnected");
  });

  it("rejects missing, invalid, and revoked credentials with 401", async () => {
    const { frame, token } = await createFrameFixture();
    expect(await expectUpgradeRejected("/api/frames/ws", {})).toBe(401);
    expect(
      await expectUpgradeRejected("/api/frames/ws", {
        authorization: "Bearer fc_link_wrong",
      }),
    ).toBe(401);
    await db
      .update(frames)
      .set({ status: "revoked" })
      .where(eq(frames.id, frame.id));
    expect(
      await expectUpgradeRejected("/api/frames/ws", {
        authorization: `Bearer ${token}`,
      }),
    ).toBe(401);
  });

  it("closes the socket with 4401 on a bad challenge signature", async () => {
    const { token } = await createFrameFixture();
    const wrongKey = generateKeyPairSync("ed25519").privateKey;
    const device = await openDevice(token);
    const challenge = await device.next(
      (msg) => msg.type === "challenge",
      "challenge",
    );
    const nonce = Buffer.from(String(challenge.nonce), "base64");
    device.send({ id: randomUUID(), states: {}, type: "hello" });
    device.send({
      id: randomUUID(),
      signature: sign(null, nonce, wrongKey).toString("base64"),
      type: "auth",
    });
    expect(await device.closed).toBe(4401);
    const [row] = await db.select().from(frames);
    expect(row?.connected).toBe(false);
  });

  it("kicks a live device socket with 4401 when its frame is revoked", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const device = await openDevice(token);
    await handshake(device, privateKey);

    // The real revocation path: revokeFrame marks the linked client and the
    // frames row revoked in SQL, expires pending commands, and NOTIFYs the
    // command channel — the hub's wake-up handler must kick, not drain.
    await revokeFrame(db, {
      id: frame.id,
      linkedClientId: frame.linkedClientId,
    });

    expect(await device.closed).toBe(4401);
    const [row] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    expect(row?.connected).toBe(false);
    expect(row?.status).toBe("revoked");

    // Reconnecting with the same token is now rejected at the upgrade.
    expect(
      await expectUpgradeRejected("/api/frames/ws", {
        authorization: `Bearer ${token}`,
      }),
    ).toBe(401);
  });

  it("supersedes an older socket for the same frame with 4409", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const first = await openDevice(token);
    await handshake(first, privateKey);
    const second = await openDevice(token);
    await handshake(second, privateKey);
    expect(await first.closed).toBe(4409);

    // The old socket's close must not clobber the new connection.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [row] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    expect(row?.connected).toBe(true);
    expect(hub.connectedFrames()).toBe(1);

    second.ws.close();
    await waitFor(async () => {
      const [updated] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frame.id));
      return updated && !updated.connected ? updated : undefined;
    }, "frame disconnected after second socket closed");
  });
});

describe("telemetry", () => {
  it("stores log batches, caps them, and pushes new_log to browsers", async () => {
    const { account, frame, privateKey, token } = await createFrameFixture();
    const device = await openDevice(token);
    await handshake(device, privateKey);

    const sessionToken = await createBrowserSession(account.id);
    const browser = await openBrowser(frame.id, sessionToken);

    device.send({
      id: randomUUID(),
      logs: [
        {
          payload: { event: "render:start", line: "starting" },
          timestamp: Date.now() / 1000,
        },
        {
          payload: { event: "render:done", line: "done in 1.2s" },
          timestamp: new Date().toISOString(),
        },
      ],
      type: "log_batch",
    });

    const logEvent = await browser.next(
      (msg) =>
        msg.event === "new_log" &&
        (msg.data as Record<string, unknown>).type === "render:done",
      "new_log event",
    );
    const logData = logEvent.data as Record<string, unknown>;
    expect(logData.line).toBe("done in 1.2s");
    expect(logData.frame_id).toBe(frame.id);
    expect(typeof logData.id).toBe("number");

    const stored = await db
      .select()
      .from(frameLogs)
      .where(eq(frameLogs.frameId, frame.id));
    expect(stored).toHaveLength(2);

    // Oversized batches are truncated to maxLogBatch by storeFrameLogs.
    device.send({
      id: randomUUID(),
      logs: Array.from({ length: maxLogBatch + 50 }, (_, i) => ({
        payload: { event: "spam", line: `line ${i}` },
        timestamp: Date.now() / 1000,
      })),
      type: "log_batch",
    });
    await waitFor(async () => {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(frameLogs)
        .where(eq(frameLogs.frameId, frame.id));
      return rows[0]?.count === 2 + maxLogBatch ? rows[0] : undefined;
    }, "capped log batch stored");

    device.ws.close();
    browser.ws.close();
  });

  it("refuses telemetry without the matching scopes", async () => {
    const { frame, privateKey, token } = await createFrameFixture([
      frameManagedScope,
    ]);
    const device = await openDevice(token);
    await handshake(device, privateKey);

    const logMsgId = randomUUID();
    device.send({
      id: logMsgId,
      logs: [{ payload: { event: "x", line: "y" }, timestamp: Date.now() / 1000 }],
      type: "log_batch",
    });
    const logAck = await device.next(
      (msg) => msg.type === "ack" && msg.id === logMsgId,
      "log_batch scope error ack",
    );
    expect(logAck.ok).toBe(false);
    expect(logAck.error).toBe("insufficient_scope");

    const metricsMsgId = randomUUID();
    device.send({ id: metricsMsgId, metrics: { cpu: 1 }, type: "metrics" });
    const metricsAck = await device.next(
      (msg) => msg.type === "ack" && msg.id === metricsMsgId,
      "metrics scope error ack",
    );
    expect(metricsAck.error).toBe("insufficient_scope");

    const logs = await db
      .select()
      .from(frameLogs)
      .where(eq(frameLogs.frameId, frame.id));
    expect(logs).toHaveLength(0);
    const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(row?.lastMetrics).toBeNull();
    device.ws.close();
  });
});

describe("browser socket", () => {
  it("authenticates via the session cookie and scopes access to the owner", async () => {
    const { account, frame } = await createFrameFixture();
    expect(
      await expectUpgradeRejected(`/api/frames/${frame.id}/updates`, {}),
    ).toBe(401);
    expect(
      await expectUpgradeRejected(`/api/frames/${frame.id}/updates`, {
        cookie: "frameos_cloud_session=not-a-jwt",
      }),
    ).toBe(401);

    // A different account's valid session is forbidden.
    const [otherAccount] = await db
      .insert(accounts)
      .values({ displayName: "Other" })
      .returning();
    const otherToken = await createBrowserSession(String(otherAccount?.id));
    expect(
      await expectUpgradeRejected(`/api/frames/${frame.id}/updates`, {
        cookie: `frameos_cloud_session=${otherToken}`,
      }),
    ).toBe(403);

    // A revoked session stops working even though the JWT is still valid.
    const revokedToken = await createBrowserSession(account.id);
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, hashSecret(revokedToken)));
    expect(
      await expectUpgradeRejected(`/api/frames/${frame.id}/updates`, {
        cookie: `frameos_cloud_session=${revokedToken}`,
      }),
    ).toBe(401);

    const sessionToken = await createBrowserSession(account.id);
    const browser = await openBrowser(frame.id, sessionToken);
    browser.send({ event: "ping" });
    await browser.next((msg) => msg.event === "pong", "pong for json ping");
    browser.sendRaw("ping");
    await browser.next((msg) => msg.event === "pong", "pong for raw ping");
    browser.ws.close();
  });

  it("streams all the account's frames over the account-wide fleet socket", async () => {
    const { account, frame, privateKey, token } = await createFrameFixture();
    expect(await expectUpgradeRejected("/api/frames/updates", {})).toBe(401);

    const sessionToken = await createBrowserSession(account.id);
    const fleet = await openFleetBrowser(sessionToken);

    // Events for the first frame reach the fleet socket.
    const device = await openDevice(token);
    await handshake(device, privateKey);
    await fleet.next((msg) => {
      if (msg.event !== "update_frame") {
        return false;
      }
      const data = msg.data as Record<string, unknown>;
      return data.id === frame.id && data.connected === true;
    }, "fleet update_frame for first frame");

    device.send({ id: randomUUID(), metrics: { cpu: 5 }, type: "metrics" });
    const metricsEvent = await fleet.next(
      (msg) => msg.event === "new_metrics",
      "fleet new_metrics",
    );
    expect((metricsEvent.data as Record<string, unknown>).frame_id).toBe(
      frame.id,
    );
    device.send({
      id: randomUUID(),
      logs: [{ payload: { event: "e", line: "l" }, timestamp: Date.now() / 1000 }],
      type: "log_batch",
    });
    const logEvent = await fleet.next(
      (msg) => msg.event === "new_log",
      "fleet new_log",
    );
    expect((logEvent.data as Record<string, unknown>).frame_id).toBe(frame.id);

    // A frame enrolled AFTER the fleet socket opened is covered too:
    // membership is resolved per event from the frame row's account_id.
    const late = await createFrameForAccount(account.id);
    const lateDevice = await openDevice(late.token);
    await handshake(lateDevice, late.privateKey);
    await fleet.next((msg) => {
      if (msg.event !== "update_frame") {
        return false;
      }
      const data = msg.data as Record<string, unknown>;
      return data.id === late.frame.id && data.connected === true;
    }, "fleet update_frame for late-enrolled frame");

    // Another account's frames must never leak onto this fleet socket.
    const other = await createFrameFixture();
    const otherDevice = await openDevice(other.token);
    await handshake(otherDevice, other.privateKey);
    await expect(
      fleet.next(
        (msg) =>
          (msg.data as Record<string, unknown> | undefined)?.id ===
          other.frame.id,
        "cross-account leak",
        500,
      ),
    ).rejects.toThrow(/Timed out/);

    device.ws.close();
    lateDevice.ws.close();
    otherDevice.ws.close();
    fleet.ws.close();
  });

  it("receives update_frame, scene sync, and new_metrics events live", async () => {
    const { account, frame, privateKey, token } = await createFrameFixture();
    const sessionToken = await createBrowserSession(account.id);
    const browser = await openBrowser(frame.id, sessionToken);

    const device = await openDevice(token);
    await handshake(device, privateKey);

    // Connecting broadcast an update_frame with connected: true.
    const connectedEvent = await browser.next(
      (msg) =>
        msg.event === "update_frame" &&
        (msg.data as Record<string, unknown>).connected === true,
      "update_frame on connect",
    );
    expect((connectedEvent.data as Record<string, unknown>).id).toBe(frame.id);

    // state → update_frame with the new last_state.
    device.send({
      id: randomUUID(),
      states: { active_scene: "clock" },
      type: "state",
    });
    await browser.next((msg) => {
      if (msg.event !== "update_frame") {
        return false;
      }
      const data = msg.data as Record<string, unknown>;
      const lastState = data.last_state as Record<string, unknown> | null;
      return lastState?.active_scene === "clock";
    }, "update_frame after state");

    // scene_ack → checksum sync + active scene merged into last_state.
    device.send({
      active_scene: "weather",
      checksum: "sum-2",
      id: randomUUID(),
      type: "scene_ack",
    });
    await browser.next((msg) => {
      if (msg.event !== "update_frame") {
        return false;
      }
      const data = msg.data as Record<string, unknown>;
      const lastState = data.last_state as Record<string, unknown> | null;
      return (
        data.scenes_checksum === "sum-2" &&
        lastState?.active_scene === "weather"
      );
    }, "update_frame after scene_ack");

    // metrics → new_metrics with the frame's uuid.
    device.send({
      id: randomUUID(),
      metrics: { cpu_percent: 12.5 },
      type: "metrics",
    });
    const metricsEvent = await browser.next(
      (msg) => msg.event === "new_metrics",
      "new_metrics",
    );
    const metricsData = metricsEvent.data as Record<string, unknown>;
    expect(metricsData.frame_id).toBe(frame.id);
    expect(metricsData.metrics).toEqual({ cpu_percent: 12.5 });
    expect(typeof metricsData.timestamp).toBe("string");

    // Device disconnect → update_frame with connected: false.
    device.ws.close();
    await browser.next(
      (msg) =>
        msg.event === "update_frame" &&
        (msg.data as Record<string, unknown>).connected === false,
      "update_frame on disconnect",
    );
    browser.ws.close();
  });
});
