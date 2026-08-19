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
  auditEvents,
  createDb,
  frameCommands,
  frameLogs,
  frameMetrics,
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
import {
  maxPayloadBytes,
  startFrameHub,
  type FrameHub,
  type FrameHubOptions,
} from "../../hub";
import { maxMetricsBytes, maxStateBytes } from "../../protocol";

const db = createDb();
let hub: FrameHub;
// Hubs a single test starts with non-default options; closed in afterEach.
const extraHubs: FrameHub[] = [];

beforeEach(async () => {
  await truncateAllTables();
  hub = await startFrameHub({ port: 0 });
});

afterEach(async () => {
  await hub.close();
  while (extraHubs.length > 0) {
    await extraHubs.pop()?.close();
  }
});

async function startExtraHub(options: Partial<FrameHubOptions> = {}) {
  const extra = await startFrameHub({ port: 0, ...options });
  extraHubs.push(extra);
  return extra;
}

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
  if (names.length === 0) {
    return;
  }
  // The hub finishes device messages with an unawaited-by-the-test
  // broadcastFrameUpdate (SELECTs on frames/linked_clients); a test that
  // observed its DB effect and returned can still have that tail in flight
  // when the next test's TRUNCATE wants AccessExclusiveLock — Postgres then
  // picks a deadlock victim (40P01). The reads retry themselves; when the
  // TRUNCATE is the victim, retry it too instead of failing the suite.
  for (let attempt = 1; ; attempt++) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(", ")} CASCADE`));
      return;
    } catch (error) {
      // Drizzle wraps the PostgresError (sometimes more than one level
      // deep), so walk the cause chain instead of trusting one shape.
      let isDeadlock = false;
      for (
        let cursor: unknown = error;
        cursor && typeof cursor === "object";
        cursor = (cursor as { cause?: unknown }).cause
      ) {
        const { code, message } = cursor as { code?: string; message?: string };
        if (code === "40P01" || message?.includes("deadlock detected")) {
          isDeadlock = true;
          break;
        }
      }
      if (!isDeadlock || attempt >= 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
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

// Mirrors auth-web's createSession: a token minted for the absolute ceiling,
// with the row carrying the sliding idle deadline. Overrides let a test age a
// session past either deadline.
async function createBrowserSession(
  accountId: string,
  overrides: { absoluteExpiresAt?: Date; expiresAt?: Date } = {},
) {
  const token = await new SignJWT({ profile: { accountId } })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("90d")
    .sign(derivedSigningKey("session"));
  const now = Date.now();
  await db.insert(sessions).values({
    absoluteExpiresAt:
      overrides.absoluteExpiresAt ?? new Date(now + 90 * 24 * 60 * 60 * 1000),
    accountId,
    expiresAt: overrides.expiresAt ?? new Date(now + 30 * 24 * 60 * 60 * 1000),
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
  port = hub.port,
): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
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
  port = hub.port,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => reject(new Error("upgrade unexpectedly succeeded")));
    ws.on("error", () => undefined);
  });
}

function openDevice(token: string, port = hub.port) {
  return openSocket(
    "/api/frames/ws",
    { authorization: `Bearer ${token}` },
    port,
  );
}

function openBrowser(frameId: string, sessionToken: string, port = hub.port) {
  return openSocket(
    `/api/frames/${frameId}/updates`,
    { cookie: `frameos_cloud_session=${sessionToken}` },
    port,
  );
}

function openFleetBrowser(sessionToken: string, port = hub.port) {
  return openSocket(
    "/api/frames/updates",
    { cookie: `frameos_cloud_session=${sessionToken}` },
    port,
  );
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

describe("command redelivery", () => {
  it("redelivers a command whose socket died before the ack", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const first = await openDevice(token);
    await handshake(first, privateKey);

    const command = await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { scenes: [] },
      type: "set_scenes",
    });
    await first.next(
      (msg) => msg.id === command?.id,
      "command on the first socket",
    );
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frameCommands)
        .where(eq(frameCommands.id, String(command?.id)));
      return row?.status === "sent" ? row : undefined;
    }, "command marked sent");

    // Kill the TCP connection without a close frame and without acking: the
    // command is now in "sent" with nobody to ack it.
    first.ws.terminate();
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frame.id));
      return row && !row.connected ? row : undefined;
    }, "frame marked disconnected");

    const second = await openDevice(token);
    const ready = await handshake(second, privateKey);
    // The requeued command is counted in `ready` and delivered again.
    expect(ready.pending_commands).toBe(1);
    const redelivered = await second.next(
      (msg) => msg.id === command?.id,
      "redelivered command",
    );
    expect(redelivered.type).toBe("set_scenes");

    // Acking on the new socket settles it for good.
    second.send({ id: command?.id, ok: true, type: "ack" });
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frameCommands)
        .where(eq(frameCommands.id, String(command?.id)));
      return row?.status === "acked" ? row : undefined;
    }, "redelivered command acked");
    second.ws.close();
  });

  it("does not redeliver a sent command superseded by a newer one", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const first = await openDevice(token);
    await handshake(first, privateKey);

    const stale = await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { checksum: "old" },
      type: "set_scenes",
    });
    await first.next((msg) => msg.id === stale?.id, "stale command");
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frameCommands)
        .where(eq(frameCommands.id, String(stale?.id)));
      return row?.status === "sent" ? row : undefined;
    }, "stale command marked sent");
    first.ws.terminate();

    // A newer set_scenes is queued while the frame is offline. supersede in
    // auth-web only rewrites "pending" rows, so the hub must not resurrect the
    // older one on reconnect.
    const fresh = await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { checksum: "new" },
      type: "set_scenes",
    });

    const second = await openDevice(token);
    await handshake(second, privateKey);
    const delivered = await second.next(
      (msg) => msg.type === "set_scenes",
      "newest set_scenes",
    );
    expect(delivered.id).toBe(fresh?.id);
    expect(delivered.checksum).toBe("new");
    const [staleRow] = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.id, String(stale?.id)));
    expect(staleRow?.status).toBe("expired");
    expect(staleRow?.error).toBe("superseded");
    second.ws.close();
  });

  it("promotes the per-scene ledger only on an ack of the assigned checksum", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const ledger = {
      "store-a": { checksum: "aaa", version: 3 },
      "store-b": { checksum: "bbb", version: 1 },
    };
    await db
      .update(frames)
      .set({ assignedChecksum: "sum-assigned", assignedSceneState: ledger })
      .where(eq(frames.id, frame.id));

    const device = await openDevice(token);
    await handshake(device, privateKey);

    // An ack for some other payload (an ad-hoc preview push, a stale set)
    // must not claim the assigned scenes were delivered.
    device.send({ checksum: "sum-preview", id: randomUUID(), type: "scene_ack" });
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frame.id));
      return row?.scenesChecksum === "sum-preview" ? row : undefined;
    }, "preview checksum stored");
    let [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(row?.deployedSceneState).toBeNull();

    // The matching ack copies the assigned ledger to deployed in the same
    // UPDATE that stores the checksum.
    device.send({ checksum: "sum-assigned", id: randomUUID(), type: "scene_ack" });
    await waitFor(async () => {
      const [updated] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frame.id));
      return updated?.scenesChecksum === "sum-assigned" ? updated : undefined;
    }, "assigned checksum stored");
    [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(row?.deployedSceneState).toEqual(ledger);
    device.ws.close();
  });

  it("expires a sent command whose TTL passed instead of redelivering it", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    // Straight into the table as "sent": a five-minute-old reboot the device
    // never acked must not fire on the next connect.
    const [command] = await db
      .insert(frameCommands)
      .values({
        expiresAt: new Date(Date.now() - 1000),
        frameId: frame.id,
        payload: null,
        sentAt: new Date(Date.now() - 60_000),
        status: "sent",
        type: "reboot",
      })
      .returning();

    const device = await openDevice(token);
    const ready = await handshake(device, privateKey);
    expect(ready.pending_commands).toBe(0);
    await expect(
      device.next((msg) => msg.type === "reboot", "unexpected reboot", 500),
    ).rejects.toThrow(/Timed out/);
    const [row] = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.id, String(command?.id)));
    expect(row?.status).toBe("expired");
    device.ws.close();
  });

  it("redelivers on a live socket once the unacked grace period passes", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const extra = await startExtraHub({ commandRedeliverAfterMs: 0 });
    const device = await openDevice(token, extra.port);
    await handshake(device, privateKey);

    const command = await enqueueFrameCommand(db, {
      frameId: frame.id,
      type: "render",
      ttlMs: 60_000,
    });
    await device.next((msg) => msg.id === command?.id, "first delivery");
    // The write happens before the row is marked sent, so wait for the mark
    // (and for the clock to move past it — the grace period here is 0).
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frameCommands)
        .where(eq(frameCommands.id, String(command?.id)));
      return row?.status === "sent" ? row : undefined;
    }, "command marked sent");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The device stays silent (no ack). One sweep past the grace period
    // requeues and sends it again on the same socket.
    await extra.sweep();
    await device.next(
      (msg) => msg.id === command?.id,
      "second delivery after the sweep",
    );
    device.ws.close();
  });
});

// The hub writes the device side of the per-frame audit trail itself
// (cloud/docs/cloud-frames.md "Account hardening"): account-scoped rows with
// actor.kind = "device" and target.frameId, which auth-web's
// /api/frames/{id}/activity serves and the workspace's Activity panel shows.
describe("device audit trail", () => {
  async function frameAuditRows(frameId: string) {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.target}->>'frameId' = ${frameId}`)
      .orderBy(auditEvents.createdAt, auditEvents.id);
    return rows;
  }

  async function waitForAuditRow(frameId: string, eventType: string) {
    return waitFor(async () => {
      const rows = await frameAuditRows(frameId);
      return rows.find((row) => row.eventType === eventType);
    }, `audit row ${eventType}`);
  }

  it("records connected (with the version), scenes applied, and a disconnect with its reason", async () => {
    // Debounce off: this test wants every lifecycle row.
    const audited = await startExtraHub({ lifecycleAuditDebounceMs: 0 });
    const { account, frame, privateKey, token } = await createFrameFixture();
    // The frame reported 2026.8.1 last time; this session says 2026.8.31.
    await db
      .update(frames)
      .set({ assignedChecksum: "sum-assigned", frameosVersion: "2026.8.1" })
      .where(eq(frames.id, frame.id));
    const sessionToken = await createBrowserSession(account.id);
    const browser = await openBrowser(frame.id, sessionToken, audited.port);

    const device = await openDevice(token, audited.port);
    await handshake(device, privateKey, { frameos_version: "2026.8.31" });

    const connected = await waitForAuditRow(frame.id, "frame.connected");
    expect(connected.accountId).toBe(account.id);
    expect(connected.actor).toEqual({ frameId: frame.id, kind: "device" });
    expect(connected.metadata).toMatchObject({ frameosVersion: "2026.8.31" });
    const versionChanged = await waitForAuditRow(
      frame.id,
      "frame.firmware_version_changed",
    );
    expect(versionChanged.metadata).toEqual({ from: "2026.8.1", to: "2026.8.31" });

    // The panel learns about the row without polling.
    const live = await browser.next(
      (msg) =>
        msg.event === "frame_activity" &&
        (msg.data as Record<string, unknown>).event_type === "frame.connected",
      "frame_activity broadcast",
    );
    expect((live.data as Record<string, unknown>).frame_id).toBe(frame.id);

    // A preview ack is not a deploy; the assigned checksum's ack is.
    device.send({ checksum: "sum-preview", id: randomUUID(), type: "scene_ack" });
    device.send({ checksum: "sum-assigned", id: randomUUID(), type: "scene_ack" });
    const applied = await waitForAuditRow(frame.id, "frame.scenes_applied");
    expect(applied.metadata).toEqual({ checksum: "sum-assigned" });
    expect(
      (await frameAuditRows(frame.id)).filter(
        (row) => row.eventType === "frame.scenes_applied",
      ),
    ).toHaveLength(1);

    // The device says goodbye (1000 = closed_by_device).
    device.ws.close(1000);
    const disconnected = await waitForAuditRow(frame.id, "frame.disconnected");
    expect(disconnected.metadata).toEqual({ reason: "closed_by_device" });
    browser.ws.close();
  });

  it("debounces a connect/disconnect flap and never double-records a superseded socket", async () => {
    // Default hub: 60 s debounce. One connect, one drop, one reconnect —
    // all within a second — leaves exactly one lifecycle row.
    const { frame, privateKey, token } = await createFrameFixture();
    const first = await openDevice(token);
    await handshake(first, privateKey);
    await waitForAuditRow(frame.id, "frame.connected");
    first.ws.close();
    await waitFor(async () => {
      const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
      return row?.connected === false ? row : undefined;
    }, "frame marked offline");
    const second = await openDevice(token);
    await handshake(second, privateKey);
    await waitFor(async () => {
      const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
      return row?.connected === true ? row : undefined;
    }, "frame back online");
    const lifecycle = (await frameAuditRows(frame.id)).filter(
      (row) =>
        row.eventType === "frame.connected" ||
        row.eventType === "frame.disconnected",
    );
    expect(lifecycle.map((row) => row.eventType)).toEqual(["frame.connected"]);
    second.ws.close();
  });

  it("records a kicked session when the frame is revoked, instead of a plain disconnect", async () => {
    const audited = await startExtraHub({ lifecycleAuditDebounceMs: 0 });
    const { frame, privateKey, token } = await createFrameFixture();
    const device = await openDevice(token, audited.port);
    await handshake(device, privateKey);
    await waitForAuditRow(frame.id, "frame.connected");

    await revokeFrame(db, { id: frame.id, linkedClientId: frame.linkedClientId });
    expect(await device.closed).toBe(4401);

    const kicked = await waitForAuditRow(frame.id, "frame.session_kicked");
    expect(kicked.metadata).toEqual({ reason: "frame_revoked" });
    expect(kicked.actor).toEqual({ frameId: frame.id, kind: "device" });
    expect(
      (await frameAuditRows(frame.id)).filter(
        (row) => row.eventType === "frame.disconnected",
      ),
    ).toHaveLength(0);
  });
});

describe("preview push", () => {
  // The fleet-preview doctrine: a device announces that it wrote a fresh
  // snapshot, and the hub fetches it only while someone has the frame open.
  // Nothing is rendered in the cloud and no device is asked to screenshot.
  async function snapshotFetches(frameId: string) {
    return await db
      .select({ payload: frameCommands.payload })
      .from(frameCommands)
      .where(
        and(
          eq(frameCommands.frameId, frameId),
          eq(frameCommands.type, "asset_get"),
        ),
      );
  }

  it("ignores a render announcement for a frame nobody is watching", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const device = await openDevice(token);
    await handshake(device, privateKey);

    device.send({ active_scene: "scene-a", type: "render" });
    // Nothing to wait *for*, so wait out a window in which the fetch would
    // have been queued and assert it was not.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await snapshotFetches(frame.id)).toHaveLength(0);
    device.ws.close();
  });

  it("fetches the scene thumbnail when a viewer is present", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    await db
      .update(frames)
      .set({ previewWatchedAt: new Date() })
      .where(eq(frames.id, frame.id));

    const device = await openDevice(token);
    await handshake(device, privateKey);
    device.send({ active_scene: "scene-a", type: "render" });

    const queued = await waitFor(async () => {
      const rows = await snapshotFetches(frame.id);
      return rows.length > 0 ? rows : undefined;
    }, "snapshot fetch queued");
    // Only the thumbnail: the full-size copy is fetched on a later render,
    // once something has actually asked for one.
    expect(queued).toHaveLength(1);
    const payload = queued[0]!.payload as Record<string, unknown>;
    expect(payload.thumb).toBe(true);
    expect(String(payload.path)).toMatch(
      /^\.frameos\/scene_images\/scene-a-[0-9a-f]{32}\.png$/,
    );

    // The device is told to send it, over the same asset_get verb the tile
    // route uses on demand.
    const command = await device.next(
      (msg) => msg.type === "asset_get",
      "asset_get delivered",
    );
    expect(command.thumb).toBe(true);
    device.ws.close();
  });

  it("stops asking once the viewer has been gone for the watch window", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    await db
      .update(frames)
      .set({ previewWatchedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(frames.id, frame.id));

    const device = await openDevice(token);
    await handshake(device, privateKey);
    device.send({ active_scene: "scene-a", type: "render" });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await snapshotFetches(frame.id)).toHaveLength(0);
    device.ws.close();
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

    // Structured payloads ship as backend-style "webhook" lines: the whole
    // object JSON-encoded, so the SPA renders event + key=value instead of
    // raw JSON.
    const logEvent = await browser.next(
      (msg) =>
        msg.event === "new_log" &&
        String((msg.data as Record<string, unknown>).line).includes("render:done"),
      "new_log event",
    );
    const logData = logEvent.data as Record<string, unknown>;
    expect(logData.type).toBe("webhook");
    expect(JSON.parse(String(logData.line))).toEqual({
      event: "render:done",
      line: "done in 1.2s",
    });
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

describe("inbound size limits", () => {
  it("closes a socket that sends a frame over maxPayload", async () => {
    const { privateKey, token } = await createFrameFixture();
    const device = await openDevice(token);
    await handshake(device, privateKey);
    device.sendRaw(
      JSON.stringify({
        id: randomUUID(),
        states: { blob: "x".repeat(maxPayloadBytes) },
        type: "state",
      }),
    );
    // 1009 = message too big; ws refuses it without buffering the payload.
    expect(await device.closed).toBe(1009);
  });

  it("rejects an oversized state and keeps the last good one", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const device = await openDevice(token);
    await handshake(device, privateKey);

    device.send({
      id: randomUUID(),
      states: { blob: "x".repeat(maxStateBytes) },
      type: "state",
    });
    // Followed by a well-formed state: once that lands, the oversized one has
    // certainly been processed (messages are handled in order).
    device.send({
      id: randomUUID(),
      states: { active_scene: "clock" },
      type: "state",
    });
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frame.id));
      const state = row?.lastState as Record<string, unknown> | null;
      return state?.active_scene === "clock" ? row : undefined;
    }, "recovered state");
    const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(row?.lastState).toEqual({ active_scene: "clock" });
    device.ws.close();
  });

  it("rejects oversized metrics with an ack error", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const device = await openDevice(token);
    await handshake(device, privateKey);
    const msgId = randomUUID();
    device.send({
      id: msgId,
      metrics: { blob: "x".repeat(maxMetricsBytes) },
      type: "metrics",
    });
    const ack = await device.next(
      (msg) => msg.type === "ack" && msg.id === msgId,
      "metrics size error ack",
    );
    expect(ack.error).toBe("payload_too_large");
    const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(row?.lastMetrics).toBeNull();
    device.ws.close();
  });

  it("drops log lines over the 8 KB per-line cap and keeps the rest", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const device = await openDevice(token);
    await handshake(device, privateKey);
    device.send({
      id: randomUUID(),
      logs: [
        { payload: { line: "x".repeat(9 * 1024) }, timestamp: Date.now() / 1000 },
        { payload: { line: "kept" }, timestamp: Date.now() / 1000 },
      ],
      type: "log_batch",
    });
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(frameLogs)
        .where(eq(frameLogs.frameId, frame.id));
      return rows.length > 0 ? rows : undefined;
    }, "log stored");
    const rows = await db
      .select()
      .from(frameLogs)
      .where(eq(frameLogs.frameId, frame.id));
    expect(rows).toHaveLength(1);
    expect((rows[0]?.payload as { line: string }).line).toBe("kept");
    device.ws.close();
  });

  it("rate limits a device that floods log batches", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const device = await openDevice(token);
    await handshake(device, privateKey);

    // The limit is 120 batches per minute per frame; message handling is
    // serialized, so the 121st is answered after the first 120 landed.
    let limitedAck: Record<string, unknown> | undefined;
    for (let i = 0; i < 121; i += 1) {
      const msgId = randomUUID();
      device.send({
        id: msgId,
        logs: [{ payload: { line: `line ${i}` }, timestamp: Date.now() / 1000 }],
        type: "log_batch",
      });
      if (i === 120) {
        limitedAck = await device.next(
          (msg) => msg.type === "ack" && msg.id === msgId,
          "rate limited ack",
        );
      }
    }
    expect(limitedAck?.error).toBe("rate_limited");
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(frameLogs)
      .where(eq(frameLogs.frameId, frame.id));
    expect(rows[0]?.count).toBe(120);
    device.ws.close();
  });

  // The scene from the wire contract's {"timestamp","scene","payload"} entry
  // has no column of its own, so it must survive inside the stored payload.
  it("keeps the optional per-entry scene", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const device = await openDevice(token);
    await handshake(device, privateKey);
    device.send({
      id: randomUUID(),
      logs: [
        {
          payload: { line: "rendered" },
          scene: "kitchen-clock",
          timestamp: Date.now() / 1000,
        },
      ],
      type: "log_batch",
    });
    const stored = await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frameLogs)
        .where(eq(frameLogs.frameId, frame.id));
      return row;
    }, "log with scene stored");
    expect(stored.payload).toEqual({ line: "rendered", scene: "kitchen-clock" });
    device.ws.close();
  });
});

describe("connection guards", () => {
  it("refuses a browser upgrade from a foreign Origin", async () => {
    const { account, frame } = await createFrameFixture();
    const sessionToken = await createBrowserSession(account.id);
    const cookie = `frameos_cloud_session=${sessionToken}`;
    expect(
      await expectUpgradeRejected(`/api/frames/${frame.id}/updates`, {
        cookie,
        origin: "https://evil.example",
      }),
    ).toBe(403);
    expect(
      await expectUpgradeRejected("/api/frames/updates", {
        cookie,
        origin: "https://evil.example",
      }),
    ).toBe(403);

    // The configured app origin (localhost:3000 by default) is accepted, and
    // so is a request with no Origin at all — those are never browsers.
    const browser = await openSocket(`/api/frames/${frame.id}/updates`, {
      cookie,
      origin: "http://localhost:3000",
    });
    browser.ws.close();
  });

  it("closes a browser socket whose session was revoked after the upgrade", async () => {
    const { account, frame } = await createFrameFixture();
    const sessionToken = await createBrowserSession(account.id);
    const browser = await openBrowser(frame.id, sessionToken);
    const fleet = await openFleetBrowser(sessionToken);

    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, hashSecret(sessionToken)));
    await hub.sweep();

    expect(await browser.closed).toBe(4401);
    expect(await fleet.closed).toBe(4401);
  });

  it("refuses upgrades past the connection cap", async () => {
    const { account, frame } = await createFrameFixture();
    const sessionToken = await createBrowserSession(account.id);
    const previous = process.env.FRAME_HUB_MAX_CONNECTIONS;
    process.env.FRAME_HUB_MAX_CONNECTIONS = "1";
    try {
      const extra = await startExtraHub();
      const browser = await openBrowser(frame.id, sessionToken, extra.port);
      expect(
        await expectUpgradeRejected(
          "/api/frames/updates",
          { cookie: `frameos_cloud_session=${sessionToken}` },
          extra.port,
        ),
      ).toBe(503);
      browser.ws.close();
    } finally {
      if (previous === undefined) {
        delete process.env.FRAME_HUB_MAX_CONNECTIONS;
      } else {
        process.env.FRAME_HUB_MAX_CONNECTIONS = previous;
      }
    }
  });

  it("rate limits upgrade attempts per client IP", async () => {
    // 120 attempts per minute; the 121st from the same forwarded IP is 429
    // even though it never reaches authentication.
    const headers = { "x-forwarded-for": "203.0.113.9" };
    let last = 0;
    for (let i = 0; i < 121; i += 1) {
      last = await expectUpgradeRejected("/api/frames/ws", headers);
    }
    expect(last).toBe(429);
    // A different client IP still gets through to the normal 401.
    expect(
      await expectUpgradeRejected("/api/frames/ws", {
        "x-forwarded-for": "203.0.113.10",
      }),
    ).toBe(401);
  });
});

describe("lifecycle", () => {
  it("closes a device socket that never completes the challenge", async () => {
    const { token } = await createFrameFixture();
    const extra = await startExtraHub({ authTimeoutMs: 200 });
    const device = await openDevice(token, extra.port);
    await device.next((msg) => msg.type === "challenge", "challenge");
    // 4408, NOT 4401: devices demote themselves to standalone after three
    // 4401s, and a device that is merely slow (an e-paper refresh can stall
    // the handshake past the window) must not eat auth strikes for it.
    expect(await device.closed).toBe(4408);
  });

  it("terminates a device socket that stops answering pings", async () => {
    const { frame, privateKey, token } = await createFrameFixture();
    const extra = await startExtraHub({ heartbeatIntervalMs: 150 });
    const device = await openDevice(token, extra.port);
    await handshake(device, privateKey);
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frame.id));
      return row?.connected ? row : undefined;
    }, "frame connected");

    // Pausing the client socket stops ws from answering the protocol ping,
    // which is exactly what a wedged device looks like.
    device.ws.pause();
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frame.id));
      return row && !row.connected ? row : undefined;
    }, "frame terminated by the heartbeat");
  });

  it("clears stale connectivity rows at boot", async () => {
    const { frame } = await createFrameFixture();
    await db
      .update(frames)
      .set({ connected: true, hubSessionId: "hub-from-a-previous-life" })
      .where(eq(frames.id, frame.id));
    await startExtraHub();
    const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(row?.connected).toBe(false);
    expect(row?.hubSessionId).toBeNull();
  });

  it("closes every socket with 1001 on graceful shutdown", async () => {
    const { account, frame, privateKey, token } = await createFrameFixture();
    const extra = await startExtraHub();
    const sessionToken = await createBrowserSession(account.id);
    const device = await openDevice(token, extra.port);
    await handshake(device, privateKey);
    const browser = await openBrowser(frame.id, sessionToken, extra.port);
    const fleet = await openFleetBrowser(sessionToken, extra.port);

    await extra.close();
    expect(await device.closed).toBe(1001);
    expect(await browser.closed).toBe(1001);
    expect(await fleet.closed).toBe(1001);
    const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(row?.connected).toBe(false);
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

  // Sessions slide, so the hub must honour both deadlines auth-web keeps: the
  // idle one it pushes forward, and the ceiling it never pushes past.
  it("rejects sessions past either deadline, however fresh the JWT", async () => {
    const { account, frame } = await createFrameFixture();

    const idled = await createBrowserSession(account.id, {
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(
      await expectUpgradeRejected(`/api/frames/${frame.id}/updates`, {
        cookie: `frameos_cloud_session=${idled}`,
      }),
    ).toBe(401);

    // Used seconds ago — the idle deadline is wide open — but the session has
    // simply existed for too long.
    const capped = await createBrowserSession(account.id, {
      absoluteExpiresAt: new Date(Date.now() - 1000),
    });
    expect(
      await expectUpgradeRejected(`/api/frames/${frame.id}/updates`, {
        cookie: `frameos_cloud_session=${capped}`,
      }),
    ).toBe(401);
  });

  it("closes a browser socket whose session hits its absolute ceiling", async () => {
    const { account, frame } = await createFrameFixture();
    const sessionToken = await createBrowserSession(account.id);
    const browser = await openBrowser(frame.id, sessionToken);
    const fleet = await openFleetBrowser(sessionToken);

    await db
      .update(sessions)
      .set({ absoluteExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hashSecret(sessionToken)));
    await hub.sweep();

    expect(await browser.closed).toBe(4401);
    expect(await fleet.closed).toBe(4401);
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

    // The sample is also retained for the Metrics panel's history, and the
    // broadcast carries the stored row's id/timestamp so live samples and
    // /metrics refetches dedupe cleanly in the SPA.
    const storedMetrics = await db
      .select()
      .from(frameMetrics)
      .where(eq(frameMetrics.frameId, frame.id));
    expect(storedMetrics).toHaveLength(1);
    expect(storedMetrics[0]!.payload).toEqual({ cpu_percent: 12.5 });
    expect(metricsData.id).toBe(String(storedMetrics[0]!.id));
    expect(metricsData.timestamp).toBe(
      storedMetrics[0]!.timestamp.toISOString(),
    );

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
