// FrameOS Cloud frame hub: the WebSocket control plane for cloud-managed
// frames. Wire contract: docs/cloud-frames.md at the repo root; design:
// cloud/docs/cloud-frames.md ("WS hub placement", "Single-host constraint").
//
// Three socket surfaces on one HTTP server:
//   - /api/frames/ws               — device sockets (Bearer link token +
//                                    Ed25519 challenge/response)
//   - /api/frames/{id}/updates     — browser socket, one frame
//   - /api/frames/updates          — browser socket, all the account's
//                                    frames (fleet view)
// (browser sockets authenticate with the auth-web session cookie),
// plus GET /healthz.
//
// All durable state (connectivity, the command queue, logs) lives in
// Postgres; the in-memory maps here are only the routing table for live
// sockets, so a second hub instance stays possible later.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import postgres from "postgres";
import { WebSocket, WebSocketServer } from "ws";
import {
  createDb,
  frameCommands,
  frameLogs,
  frames,
  linkedClients,
} from "@frameos-cloud/db";
// Shared helpers imported directly from auth-web source; those files are
// deliberately free of Next imports so the hub can consume them (see the
// header comment in cloud/apps/auth-web/src/lib/frames.ts).
import { authenticateLinkedClient, linkedClientScopes } from "../../auth-web/src/lib/backend-auth";
import {
  frameCommandsNotifyChannel,
  frameForLinkedClient,
  frameTelemetryLogsScope,
  frameTelemetryMetricsScope,
  storeFrameLogs,
  verifyFrameSignature,
} from "../../auth-web/src/lib/frames";
import { errorField, logError, logInfo, logWarn } from "./log";
import {
  browserEvent,
  commandMessage,
  deviceAuthError,
  frameUpdateEvent,
  isRecord,
  newLogEvent,
  parseJsonMessage,
  parseLogEntries,
  uuidPattern,
  type FrameRow,
} from "./protocol";
import { authenticateBrowserSession } from "./session-auth";

const devicePath = "/api/frames/ws";
const browserAccountPath = "/api/frames/updates";
const browserFramePathPattern = /^\/api\/frames\/([0-9a-f-]{36})\/updates$/i;

// Close codes: 4401 = authentication failed (bad signature or timeout),
// 4409 = superseded by a newer socket for the same frame.
const closeAuthFailed = 4401;
const closeSuperseded = 4409;

const authTimeoutMs = 15_000;
const heartbeatIntervalMs = 30_000;
const sweepIntervalMs = 30_000;

interface DeviceSession {
  alive: boolean;
  authTimeout: NodeJS.Timeout | undefined;
  authed: boolean;
  closed: boolean;
  disconnectHandled: boolean;
  drainQueued: boolean;
  draining: boolean;
  frame: FrameRow;
  hello: Record<string, unknown> | undefined;
  hubSessionId: string;
  nonce: Buffer;
  ready: boolean;
  scopes: string[];
  ws: WebSocket;
}

interface BrowserConnection {
  alive: boolean;
  ws: WebSocket;
}

export interface FrameHubOptions {
  // 0 = pick an ephemeral port (tests).
  port: number;
  databaseUrl?: string;
}

export interface FrameHub {
  port: number;
  connectedFrames(): number;
  close(): Promise<void>;
}

export async function startFrameHub(
  options: FrameHubOptions,
): Promise<FrameHub> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the frame hub");
  }
  const db = createDb(databaseUrl);

  const deviceSessions = new Map<string, DeviceSession>();
  // Browser subscriptions: per-frame sockets keyed by frame id, fleet-view
  // sockets keyed by account id. Routing happens at broadcast time from the
  // frame row's account_id, so frames enrolled after a fleet socket opened
  // are covered automatically (no subscription list to refresh, no race).
  const frameBrowserSockets = new Map<string, Set<BrowserConnection>>();
  const accountBrowserSockets = new Map<string, Set<BrowserConnection>>();

  // Single-host constraint (cloud/docs/cloud-frames.md): the hub runs as one
  // instance, so a restarted hub owns every frame — clear all stale liveness
  // rows at boot. When a second instance ever exists, this must become a
  // per-instance sweep keyed on hub_session_id ownership instead.
  await db
    .update(frames)
    .set({ connected: false, hubSessionId: null, updatedAt: new Date() })
    .where(eq(frames.connected, true));

  function sendToConnections(
    connections: Set<BrowserConnection> | undefined,
    message: string,
  ) {
    if (!connections) {
      return;
    }
    for (const connection of connections) {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(message);
      }
    }
  }

  // Single broadcast path for every browser event: the per-frame sockets and
  // the account-wide fleet sockets receive identically shaped messages.
  function broadcastToBrowsers(
    frame: { accountId: string; id: string },
    event: string,
    data: unknown,
  ) {
    const message = browserEvent(event, data);
    sendToConnections(frameBrowserSockets.get(frame.id), message);
    sendToConnections(accountBrowserSockets.get(frame.accountId), message);
  }

  async function broadcastFrameUpdate(frameId: string) {
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId))
      .limit(1);
    if (frame) {
      broadcastToBrowsers(frame, "update_frame", frameUpdateEvent(frame));
    }
  }

  async function expireStaleCommands(frameId?: string) {
    await db
      .update(frameCommands)
      .set({ status: "expired" })
      .where(
        and(
          eq(frameCommands.status, "pending"),
          lt(frameCommands.expiresAt, new Date()),
          ...(frameId ? [eq(frameCommands.frameId, frameId)] : []),
        ),
      );
  }

  // Drain the durable command queue to a live device socket, oldest first.
  // Serialized per session: a NOTIFY landing mid-drain queues one more pass.
  async function drainCommands(session: DeviceSession) {
    if (!session.ready || session.closed) {
      return;
    }
    if (session.draining) {
      session.drainQueued = true;
      return;
    }
    session.draining = true;
    try {
      do {
        session.drainQueued = false;
        await expireStaleCommands(session.frame.id);
        const pending = await db
          .select()
          .from(frameCommands)
          .where(
            and(
              eq(frameCommands.frameId, session.frame.id),
              eq(frameCommands.status, "pending"),
            ),
          )
          .orderBy(asc(frameCommands.createdAt), asc(frameCommands.id));
        for (const command of pending) {
          if (session.ws.readyState !== WebSocket.OPEN) {
            return;
          }
          session.ws.send(JSON.stringify(commandMessage(command)));
          await db
            .update(frameCommands)
            .set({ sentAt: new Date(), status: "sent" })
            .where(
              and(
                eq(frameCommands.id, command.id),
                eq(frameCommands.status, "pending"),
              ),
            );
        }
      } while (session.drainQueued);
    } finally {
      session.draining = false;
    }
  }

  // Revocation kick: revokeFrame() in auth-web marks the linked client and
  // the frames row revoked, then NOTIFYs the command channel. Both wake-up
  // paths (NOTIFY and the 30s sweep) recheck and close a revoked frame's
  // live socket with 4401 — the same code the device treats as "link is
  // dead" — instead of draining commands to it.
  async function isFrameRevoked(session: DeviceSession) {
    const [row] = await db
      .select({ revokedAt: linkedClients.revokedAt, status: frames.status })
      .from(frames)
      .innerJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
      .where(eq(frames.id, session.frame.id))
      .limit(1);
    return !row || row.status === "revoked" || row.revokedAt !== null;
  }

  async function kickRevokedSession(session: DeviceSession) {
    logInfo("device.kicked_revoked", { frameId: session.frame.id });
    // Mark disconnected (connected=false + update_frame broadcast) before
    // closing, so the state flip does not wait on the close handshake.
    await markDeviceDisconnected(session);
    session.ws.close(closeAuthFailed, "frame_revoked");
  }

  // Command wake-up entry point shared by LISTEN/NOTIFY and the sweep.
  async function wakeSession(session: DeviceSession) {
    if (!session.ready || session.closed) {
      return;
    }
    if (await isFrameRevoked(session)) {
      await kickRevokedSession(session);
      return;
    }
    await drainCommands(session);
  }

  async function activateDeviceSession(session: DeviceSession) {
    session.ready = true;
    if (session.authTimeout) {
      clearTimeout(session.authTimeout);
      session.authTimeout = undefined;
    }
    const frameId = session.frame.id;

    // Single frame = single live socket: the newer authenticated connection
    // wins; the previous socket's close handler cannot clobber this one
    // because disconnect updates are guarded by hub_session_id.
    const previous = deviceSessions.get(frameId);
    if (previous && previous !== session) {
      previous.ws.close(closeSuperseded, "superseded");
    }
    deviceSessions.set(frameId, session);

    const hello = session.hello ?? {};
    const now = new Date();
    await db
      .update(frames)
      .set({
        connected: true,
        hubSessionId: session.hubSessionId,
        lastSeenAt: now,
        updatedAt: now,
        ...(typeof hello.frameos_version === "string"
          ? { frameosVersion: hello.frameos_version.slice(0, 64) }
          : {}),
        ...(isRecord(hello.states) ? { lastState: hello.states } : {}),
        ...(typeof hello.scenes_checksum === "string"
          ? { scenesChecksum: hello.scenes_checksum }
          : {}),
      })
      .where(eq(frames.id, frameId));

    await expireStaleCommands(frameId);
    const [pendingRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(frameCommands)
      .where(
        and(
          eq(frameCommands.frameId, frameId),
          eq(frameCommands.status, "pending"),
        ),
      );
    const pendingCount = pendingRow?.count ?? 0;
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(
        JSON.stringify({
          id: randomUUID(),
          pending_commands: pendingCount,
          type: "ready",
        }),
      );
    }
    logInfo("device.connected", { frameId, pendingCommands: pendingCount });
    await broadcastFrameUpdate(frameId);
    await drainCommands(session);

    // The socket closed while the writes above were in flight: run the
    // disconnect bookkeeping this close handler may have raced past.
    if (session.closed) {
      await markDeviceDisconnected(session);
    }
  }

  async function markDeviceDisconnected(session: DeviceSession) {
    // Idempotent: the revocation kick runs this before closing the socket,
    // and the close handler would otherwise run it a second time.
    if (session.disconnectHandled) {
      return;
    }
    session.disconnectHandled = true;
    if (deviceSessions.get(session.frame.id) === session) {
      deviceSessions.delete(session.frame.id);
    }
    // Guarded by hub_session_id: a newer connection for the same frame must
    // not be marked offline by an old socket's late close event.
    const updated = await db
      .update(frames)
      .set({ connected: false, updatedAt: new Date() })
      .where(
        and(
          eq(frames.id, session.frame.id),
          eq(frames.hubSessionId, session.hubSessionId),
        ),
      )
      .returning({ id: frames.id });
    if (updated.length > 0) {
      await broadcastFrameUpdate(session.frame.id);
    }
  }

  function sendAckError(
    session: DeviceSession,
    msg: Record<string, unknown>,
    error: string,
  ) {
    if (session.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    session.ws.send(
      JSON.stringify({
        ...(typeof msg.id === "string" ? { id: msg.id } : {}),
        error,
        ok: false,
        type: "ack",
      }),
    );
  }

  async function handleAck(
    session: DeviceSession,
    msg: Record<string, unknown>,
  ) {
    const commandId =
      typeof msg.id === "string" && uuidPattern.test(msg.id)
        ? msg.id
        : undefined;
    if (!commandId) {
      return;
    }
    const ok = msg.ok === true;
    // A failed set_scenes deliberately leaves frames.assigned_checksum as is:
    // desired != acked keeps the frame showing out-of-sync in the UI.
    await db
      .update(frameCommands)
      .set({
        ackedAt: new Date(),
        error: ok
          ? null
          : typeof msg.error === "string"
            ? msg.error.slice(0, 512)
            : "error",
        status: ok ? "acked" : "failed",
      })
      .where(
        and(
          eq(frameCommands.id, commandId),
          eq(frameCommands.frameId, session.frame.id),
          inArray(frameCommands.status, ["pending", "sent"]),
        ),
      );
  }

  async function handleSceneAck(
    session: DeviceSession,
    msg: Record<string, unknown>,
  ) {
    const checksum = typeof msg.checksum === "string" ? msg.checksum : undefined;
    const activeScene =
      typeof msg.active_scene === "string" ? msg.active_scene : undefined;
    const now = new Date();
    await db
      .update(frames)
      .set({
        lastSeenAt: now,
        updatedAt: now,
        ...(checksum !== undefined ? { scenesChecksum: checksum } : {}),
        ...(activeScene !== undefined
          ? {
              lastState: sql`coalesce(${frames.lastState}, '{}'::jsonb) || jsonb_build_object('active_scene', ${activeScene}::text)`,
            }
          : {}),
      })
      .where(eq(frames.id, session.frame.id));
    await broadcastFrameUpdate(session.frame.id);
  }

  async function handleState(
    session: DeviceSession,
    msg: Record<string, unknown>,
  ) {
    // `state` is hello-shaped; some payloads nest scene state under `states`,
    // so prefer that and fall back to the whole payload minus the envelope.
    const { id: _id, type: _type, ...rest } = msg;
    const lastState = isRecord(rest.states) ? rest.states : rest;
    const now = new Date();
    await db
      .update(frames)
      .set({
        lastSeenAt: now,
        lastState,
        updatedAt: now,
        ...(typeof rest.frameos_version === "string"
          ? { frameosVersion: rest.frameos_version.slice(0, 64) }
          : {}),
        ...(typeof rest.scenes_checksum === "string"
          ? { scenesChecksum: rest.scenes_checksum }
          : {}),
      })
      .where(eq(frames.id, session.frame.id));
    await broadcastFrameUpdate(session.frame.id);
  }

  async function handleLogBatch(
    session: DeviceSession,
    msg: Record<string, unknown>,
  ) {
    if (!session.scopes.includes(frameTelemetryLogsScope)) {
      sendAckError(session, msg, "insufficient_scope");
      return;
    }
    const entries = parseLogEntries(msg.logs);
    if (entries.length === 0) {
      return;
    }
    // storeFrameLogs enforces the per-frame retention cap and per-line size
    // limits in the same transaction as the insert.
    const stored = await storeFrameLogs(db, session.frame.id, entries);
    if (stored === 0) {
      return;
    }
    const rows = await db
      .select({
        id: frameLogs.id,
        payload: frameLogs.payload,
        timestamp: frameLogs.timestamp,
      })
      .from(frameLogs)
      .where(eq(frameLogs.frameId, session.frame.id))
      .orderBy(desc(frameLogs.id))
      .limit(stored);
    for (const row of rows.reverse()) {
      broadcastToBrowsers(
        session.frame,
        "new_log",
        newLogEvent(session.frame.id, row),
      );
    }
  }

  async function handleMetrics(
    session: DeviceSession,
    msg: Record<string, unknown>,
  ) {
    if (!session.scopes.includes(frameTelemetryMetricsScope)) {
      sendAckError(session, msg, "insufficient_scope");
      return;
    }
    const metrics = isRecord(msg.metrics) ? msg.metrics : undefined;
    if (!metrics) {
      return;
    }
    const now = new Date();
    await db
      .update(frames)
      .set({ lastMetrics: metrics, lastSeenAt: now, updatedAt: now })
      .where(eq(frames.id, session.frame.id));
    broadcastToBrowsers(session.frame, "new_metrics", {
      frame_id: session.frame.id,
      metrics,
      timestamp: now.toISOString(),
    });
  }

  async function handleDeviceMessage(session: DeviceSession, data: unknown) {
    const msg = parseJsonMessage(data);
    if (!msg || typeof msg.type !== "string") {
      return;
    }

    if (!session.ready) {
      // Session start tolerates hello arriving before or after the challenge
      // and auth in either order relative to hello.
      if (msg.type === "hello") {
        session.hello = msg;
      } else if (msg.type === "auth") {
        const signature =
          typeof msg.signature === "string" ? msg.signature : "";
        if (
          !verifyFrameSignature(
            session.frame.publicKey,
            session.nonce,
            signature,
          )
        ) {
          logWarn("device.auth_failed", { frameId: session.frame.id });
          session.ws.close(closeAuthFailed, "invalid_signature");
          return;
        }
        session.authed = true;
      }
      if (session.authed && session.hello && !session.ready) {
        await activateDeviceSession(session);
      }
      return;
    }

    switch (msg.type) {
      case "ack":
        await handleAck(session, msg);
        break;
      case "scene_ack":
        await handleSceneAck(session, msg);
        break;
      case "state":
        await handleState(session, msg);
        break;
      case "log_batch":
        await handleLogBatch(session, msg);
        break;
      case "metrics":
        await handleMetrics(session, msg);
        break;
      default:
        // Forward compatibility: unknown frame → provider types are ignored.
        break;
    }
  }

  function attachDeviceSocket(ws: WebSocket, frame: FrameRow, scopes: string[]) {
    const session: DeviceSession = {
      alive: true,
      authTimeout: undefined,
      authed: false,
      closed: false,
      disconnectHandled: false,
      drainQueued: false,
      draining: false,
      frame,
      hello: undefined,
      hubSessionId: randomUUID(),
      nonce: randomBytes(32),
      ready: false,
      scopes,
      ws,
    };

    ws.send(
      JSON.stringify({
        id: randomUUID(),
        nonce: session.nonce.toString("base64"),
        type: "challenge",
      }),
    );
    session.authTimeout = setTimeout(() => {
      if (!session.ready) {
        logWarn("device.auth_timeout", { frameId: frame.id });
        ws.close(closeAuthFailed, "auth_timeout");
      }
    }, authTimeoutMs);

    ws.on("pong", () => {
      session.alive = true;
      if (session.ready && !session.closed) {
        db.update(frames)
          .set({ lastSeenAt: new Date() })
          .where(eq(frames.id, frame.id))
          .catch((error: unknown) =>
            logError("device.pong_update_failed", {
              error: errorField(error),
              frameId: frame.id,
            }),
          );
      }
    });
    ws.on("message", (data) => {
      handleDeviceMessage(session, data).catch((error: unknown) => {
        logError("device.message_failed", {
          error: errorField(error),
          frameId: frame.id,
        });
      });
    });
    ws.on("error", (error) => {
      logWarn("device.socket_error", {
        error: errorField(error),
        frameId: frame.id,
      });
    });
    ws.on("close", () => {
      session.closed = true;
      if (session.authTimeout) {
        clearTimeout(session.authTimeout);
        session.authTimeout = undefined;
      }
      if (!session.ready) {
        return;
      }
      logInfo("device.disconnected", { frameId: frame.id });
      markDeviceDisconnected(session).catch((error: unknown) =>
        logError("device.disconnect_failed", {
          error: errorField(error),
          frameId: frame.id,
        }),
      );
    });
  }

  // Shared attachment for both browser socket flavors; `registry` is either
  // frameBrowserSockets (key = frame id) or accountBrowserSockets
  // (key = account id).
  function attachBrowserSocket(
    ws: WebSocket,
    registry: Map<string, Set<BrowserConnection>>,
    key: string,
  ) {
    const connection: BrowserConnection = { alive: true, ws };
    let connections = registry.get(key);
    if (!connections) {
      connections = new Set();
      registry.set(key, connections);
    }
    connections.add(connection);

    ws.on("pong", () => {
      connection.alive = true;
    });
    ws.on("message", (data) => {
      // Keepalives only: reply pong to {"event":"ping"} or a raw "ping";
      // tolerate anything else silently.
      const text = typeof data === "string" ? data : String(data);
      if (text === "ping") {
        ws.send(browserEvent("pong", {}));
        return;
      }
      const msg = parseJsonMessage(data);
      if (msg && (msg.event === "ping" || msg.type === "ping")) {
        ws.send(browserEvent("pong", {}));
      }
    });
    ws.on("error", (error) => {
      logWarn("browser.socket_error", { error: errorField(error), key });
    });
    ws.on("close", () => {
      const set = registry.get(key);
      if (set) {
        set.delete(connection);
        if (set.size === 0) {
          registry.delete(key);
        }
      }
    });
  }

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.split("?")[0] === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ connected_frames: deviceSessions.size }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const wss = new WebSocketServer({ noServer: true });

  function rejectUpgrade(socket: Duplex, status: number, reason: string) {
    const text =
      status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found";
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${
        Buffer.byteLength(`{"error":"${reason}"}`)
      }\r\n\r\n{"error":"${reason}"}`,
    );
    socket.destroy();
  }

  async function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) {
    const pathname = (req.url ?? "").split("?")[0] ?? "";

    if (pathname === devicePath) {
      // Device auth step 1: the Bearer link token (hashed at rest, rotation
      // grace and revocation handled by authenticateLinkedClient). Step 2 —
      // the Ed25519 challenge — happens on the socket itself.
      const linkedClient = await authenticateLinkedClient(
        db,
        req.headers.authorization ?? null,
      );
      const frame = linkedClient
        ? await frameForLinkedClient(db, linkedClient.id)
        : undefined;
      const authError = deviceAuthError(linkedClient, frame);
      if (authError || !linkedClient || !frame) {
        logWarn("device.upgrade_rejected", { reason: authError ?? "unknown" });
        rejectUpgrade(socket, 401, authError ?? "unauthorized");
        return;
      }
      const scopes = linkedClientScopes(linkedClient);
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachDeviceSocket(ws, frame, scopes);
      });
      return;
    }

    // Fleet view: one socket for every frame the account owns, including
    // frames enrolled after the socket opened (membership is resolved per
    // event at broadcast time).
    if (pathname === browserAccountPath) {
      const accountId = await authenticateBrowserSession(
        db,
        req.headers.cookie,
      );
      if (!accountId) {
        rejectUpgrade(socket, 401, "unauthorized");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachBrowserSocket(ws, accountBrowserSockets, accountId);
      });
      return;
    }

    const browserMatch = pathname.match(browserFramePathPattern);
    if (browserMatch) {
      const frameId = browserMatch[1];
      if (!frameId || !uuidPattern.test(frameId)) {
        rejectUpgrade(socket, 404, "not_found");
        return;
      }
      const accountId = await authenticateBrowserSession(
        db,
        req.headers.cookie,
      );
      if (!accountId) {
        rejectUpgrade(socket, 401, "unauthorized");
        return;
      }
      const [frame] = await db
        .select({ accountId: frames.accountId, id: frames.id })
        .from(frames)
        .where(eq(frames.id, frameId))
        .limit(1);
      if (!frame || frame.accountId !== accountId) {
        // 403 either way; the not-found case stays indistinguishable so the
        // endpoint does not confirm which frame ids exist.
        rejectUpgrade(socket, 403, "forbidden");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachBrowserSocket(ws, frameBrowserSockets, frameId);
      });
      return;
    }

    rejectUpgrade(socket, 404, "not_found");
  }

  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((error: unknown) => {
      logError("upgrade.failed", { error: errorField(error) });
      socket.destroy();
    });
  });

  // Command wake-up: LISTEN on the channel enqueueFrameCommand NOTIFYs
  // (payload = frame id). The queue itself is durable; this is only a nudge.
  const listenClient = postgres(databaseUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  await listenClient.listen(frameCommandsNotifyChannel, (payload) => {
    const session = payload ? deviceSessions.get(payload) : undefined;
    if (session?.ready) {
      wakeSession(session).catch((error: unknown) =>
        logError("drain.notify_failed", {
          error: errorField(error),
          frameId: payload,
        }),
      );
    }
  });

  // Liveness: ping every 30s, terminate sockets that missed a pong.
  const heartbeatTimer = setInterval(() => {
    for (const session of deviceSessions.values()) {
      if (!session.alive) {
        logWarn("device.heartbeat_timeout", { frameId: session.frame.id });
        session.ws.terminate();
        continue;
      }
      session.alive = false;
      session.ws.ping();
    }
    for (const registry of [frameBrowserSockets, accountBrowserSockets]) {
      for (const connections of registry.values()) {
        for (const connection of connections) {
          if (!connection.alive) {
            connection.ws.terminate();
            continue;
          }
          connection.alive = false;
          connection.ws.ping();
        }
      }
    }
  }, heartbeatIntervalMs);

  // Fallback sweep in case a NOTIFY was missed, plus global expiry of
  // pending commands whose TTL passed while no one was draining them.
  const sweepTimer = setInterval(() => {
    (async () => {
      await expireStaleCommands();
      for (const session of deviceSessions.values()) {
        if (session.ready) {
          await wakeSession(session);
        }
      }
    })().catch((error: unknown) =>
      logError("sweep.failed", { error: errorField(error) }),
    );
  }, sweepIntervalMs);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    address && typeof address === "object" ? address.port : options.port;

  let closed = false;
  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeatTimer);
    clearInterval(sweepTimer);
    try {
      await listenClient.end({ timeout: 5 });
    } catch (error) {
      logWarn("listen.close_failed", { error: errorField(error) });
    }

    // Graceful shutdown: mark this instance's connected frames disconnected
    // (guarded by hub_session_id) before dropping the sockets.
    const sessions = [...deviceSessions.values()];
    deviceSessions.clear();
    for (const session of sessions) {
      session.closed = true;
      try {
        await db
          .update(frames)
          .set({ connected: false, updatedAt: new Date() })
          .where(
            and(
              eq(frames.id, session.frame.id),
              eq(frames.hubSessionId, session.hubSessionId),
            ),
          );
      } catch (error) {
        logError("shutdown.disconnect_failed", {
          error: errorField(error),
          frameId: session.frame.id,
        });
      }
      session.ws.close(1001, "shutting_down");
    }
    for (const registry of [frameBrowserSockets, accountBrowserSockets]) {
      for (const connections of registry.values()) {
        for (const connection of connections) {
          connection.ws.close(1001, "shutting_down");
        }
      }
      registry.clear();
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Close frames were sent above; drop any TCP connections that linger
      // so shutdown cannot hang on a half-open peer.
      setTimeout(() => server.closeAllConnections(), 250).unref();
    });
  }

  return {
    close,
    connectedFrames: () => deviceSessions.size,
    port,
  };
}
