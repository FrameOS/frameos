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
  maxAssetFileBytes,
  parseAssetEntries,
  storeFrameAssetFile,
  storeFrameAssetListing,
  storeFrameLogs,
  verifyFrameSignature,
} from "../../auth-web/src/lib/frames";
import {
  getAllowedBrowserOrigins,
  getMaxConnections,
  isAllowedBrowserOrigin,
} from "./env";
import { errorField, logError, logInfo, logWarn } from "./log";
import {
  browserEvent,
  commandMessage,
  deviceAuthError,
  frameUpdateEvent,
  isAcceptableChecksum,
  isRecord,
  maxMetricsBytes,
  maxSceneIdChars,
  maxStateBytes,
  newLogEvent,
  parseJsonMessage,
  parseLogEntries,
  uuidPattern,
  withinJsonByteLimit,
  type FrameRow,
} from "./protocol";
import {
  checkMemoryRateLimit,
  checkSharedRateLimit,
  clientIpFromRequest,
} from "./rate-limit";
import {
  authenticateBrowserSession,
  liveSessionHashes,
  type BrowserSession,
} from "./session-auth";

const devicePath = "/api/frames/ws";
const browserAccountPath = "/api/frames/updates";
const browserFramePathPattern = /^\/api\/frames\/([0-9a-f-]{36})\/updates$/i;

// Close codes: 4401 = authentication failed (bad signature, timeout, or a
// session revoked while the socket was open), 4409 = superseded by a newer
// socket for the same frame, 1013 = "try again later" (a consumer that stopped
// reading; see maxBufferedBytes).
const closeAuthFailed = 4401;
const closeSuperseded = 4409;
const closeSlowConsumer = 1013;

const defaultAuthTimeoutMs = 15_000;
const defaultHeartbeatIntervalMs = 30_000;
const defaultSweepIntervalMs = 30_000;

// Largest inbound WebSocket frame the hub will buffer and JSON.parse. Every
// device is untrusted (cloud/docs/cloud-frames.md, threat model) and a browser
// socket is only as trustworthy as the logged-in account behind it, while ws
// defaults to a 100 MiB maxPayload — enough for one authenticated peer to
// balloon the heap. 4 MiB comfortably clears the largest legitimate inbound
// message (a maxLogBatch=200 × maxLogLineBytes=8 KiB log_batch ≈ 1.6 MiB) and
// is the same budget the device applies to what it reads, so one number
// describes the biggest frame that may cross the link in either direction —
// the assembled set_scenes payload is capped on the auth-web side to stay
// under it.
export const maxPayloadBytes = 4 * 1024 * 1024;

// A command written to the socket but never acked is invisible to a
// status="pending" drain, so a connection that dies between the write and the
// ack would strand it forever. Commands still unacked this long after they
// were written go back to "pending" and are delivered again — see
// redeliverSentCommands for the at-least-once semantics this implies.
//
// The grace period only covers the rare "still connected, write went nowhere"
// case; the common one (the connection died) is caught immediately on
// reconnect. It is therefore deliberately generous: a device acks only after
// it has applied the command, and re-pushing a scene bundle to a Pi Zero that
// is still unpacking the first copy would be wasted work. Three minutes is
// far beyond any plausible apply time and still inside the 5-minute TTL the
// action commands (render/reboot/restart_runtime) carry.
const commandRedeliverAfterMs = 180_000;

// Per-frame log ingestion ceiling. The storage caps (200/batch, 8 KiB/line,
// 5000 rows/frame) bound what is *kept*, not how often a device may make the
// hub insert, prune, select and fan out. A device batches at most every 2s
// (docs/cloud-frames.md), so 120 batches/minute is ~4x headroom.
const logBatchRateLimit = { limit: 120, windowMs: 60_000 };

// Unauthenticated upgrade attempts are cheap for the client and cost the hub a
// database select each, so they are limited per client IP through the shared
// rate_limit_buckets table (the limiter auth-web already uses). The ceiling
// has to clear the worst legitimate case: several frames behind one NAT all
// reconnecting at the device's 3s minimum backoff (~20 attempts/minute each)
// during an outage. Being limited is soft — the device just backs off further.
const upgradeRateLimit = { limit: 120, windowMs: 60_000 };

// A client whose TCP window is full but whose browser engine still answers
// protocol pings survives the heartbeat while the hub queues events in process
// memory. Past this much unflushed data the consumer is hopeless: drop it.
const maxBufferedBytes = 4 * 1024 * 1024;

// One in-flight asset_get reply stream (docs/cloud-frames.md `asset_chunk`),
// keyed by the command id it answers. In-memory only: a partial file is
// worthless, so a dropped socket simply forgets it and the command's
// at-least-once redelivery re-streams from scratch.
interface AssetStream {
  chunks: Buffer[];
  contentType: string;
  nextSeq: number;
  receivedBytes: number;
}

// Devices stream one file at a time (both reference firmwares serialize verb
// handling), so this is a protocol-violation bound, not a throughput knob.
const maxAssetStreamsPerSession = 4;

interface DeviceSession {
  alive: boolean;
  assetStreams: Map<string, AssetStream>;
  authTimeout: NodeJS.Timeout | undefined;
  authed: boolean;
  closed: boolean;
  disconnectHandled: boolean;
  drainQueued: boolean;
  draining: boolean;
  frame: FrameRow;
  hello: Record<string, unknown> | undefined;
  hubSessionId: string;
  // Serializes message handling: two concurrent log_batches would otherwise
  // each re-select the other's freshly inserted rows and double-broadcast.
  handling: Promise<void>;
  nonce: Buffer;
  ready: boolean;
  scopes: string[];
  ws: WebSocket;
}

interface BrowserConnection {
  accountId: string;
  alive: boolean;
  tokenHash: string;
  ws: WebSocket;
}

export interface FrameHubOptions {
  // 0 = pick an ephemeral port (tests).
  port: number;
  databaseUrl?: string;
  // Timer overrides. Production always uses the defaults; tests shorten them
  // (or drive the sweep by hand through FrameHub.sweep) so they do not have to
  // wait 30 seconds for a periodic behaviour to happen.
  authTimeoutMs?: number;
  commandRedeliverAfterMs?: number;
  heartbeatIntervalMs?: number;
  sweepIntervalMs?: number;
}

export interface FrameHub {
  port: number;
  connectedFrames(): number;
  // Runs one periodic sweep immediately; the interval keeps running too.
  sweep(): Promise<void>;
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
  const authTimeoutMs = options.authTimeoutMs ?? defaultAuthTimeoutMs;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;
  const sweepIntervalMs = options.sweepIntervalMs ?? defaultSweepIntervalMs;
  const redeliverAfterMs =
    options.commandRedeliverAfterMs ?? commandRedeliverAfterMs;

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
      if (connection.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      // Backpressure: a socket that is not draining accumulates the whole
      // event stream in this process's memory. Disconnect it instead — the SPA
      // reconnects and refetches, so dropping is recoverable while unbounded
      // buffering is not.
      if (connection.ws.bufferedAmount > maxBufferedBytes) {
        logWarn("browser.slow_consumer", {
          bufferedAmount: connection.ws.bufferedAmount,
          key: connection.accountId,
        });
        connection.ws.close(closeSlowConsumer, "slow_consumer");
        continue;
      }
      connection.ws.send(message);
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

  // Expiry covers "sent" as well as "pending": a command written to a socket
  // that died before acking is retried (see redeliverSentCommands), so its TTL
  // has to be able to stop it — otherwise a reboot queued five minutes ago
  // could still land after a reconnect.
  async function expireStaleCommands(frameId?: string) {
    await db
      .update(frameCommands)
      .set({ status: "expired" })
      .where(
        and(
          inArray(frameCommands.status, ["pending", "sent"]),
          lt(frameCommands.expiresAt, new Date()),
          ...(frameId ? [eq(frameCommands.frameId, frameId)] : []),
        ),
      );
  }

  // Delivery is at-least-once. The device acks by command id and every command
  // type is idempotent on the device side (set_scenes/set_settings overwrite,
  // render/reboot/restart_runtime repeat an action that is safe to repeat and
  // carry a 5-minute TTL that expireStaleCommands enforces), so redelivering
  // an unacked command is preferable to stranding it.
  //
  // Two ways a command in "sent" needs redelivering: the socket died between
  // the write and the ack (caught on reconnect, cutoff = now, because nothing
  // this session wrote can be outstanding yet), or the write was lost on a
  // still-live connection (caught by the sweep, cutoff = now minus the grace
  // period).
  async function redeliverSentCommands(frameId: string, cutoff: Date) {
    // supersedePendingCommands (auth-web) only rewrites "pending" rows, so a
    // set_scenes that was written but never acked can still be sitting in
    // "sent" when a newer one is queued. Redelivering the stale one first
    // would push a superseded payload to the device, so drop any "sent"
    // command that already has a newer command of the same type waiting.
    await db
      .update(frameCommands)
      .set({ error: "superseded", status: "expired" })
      .where(
        and(
          eq(frameCommands.frameId, frameId),
          eq(frameCommands.status, "sent"),
          lt(frameCommands.sentAt, cutoff),
          sql`exists (
            select 1 from ${frameCommands} newer
            where newer.frame_id = ${frameCommands.frameId}
              and newer.type = ${frameCommands.type}
              and newer.status in ('pending', 'sent')
              and (newer.created_at, newer.id) > (${frameCommands.createdAt}, ${frameCommands.id})
          )`,
        ),
      );
    const requeued = await db
      .update(frameCommands)
      .set({ sentAt: null, status: "pending" })
      .where(
        and(
          eq(frameCommands.frameId, frameId),
          eq(frameCommands.status, "sent"),
          lt(frameCommands.sentAt, cutoff),
        ),
      )
      .returning({ id: frameCommands.id });
    if (requeued.length > 0) {
      logWarn("command.redelivering", { count: requeued.length, frameId });
    }
    return requeued.length;
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
          // created_at is the transaction timestamp, so commands enqueued in
          // one multi-row insert share it. id is a random uuid and cannot
          // break that tie meaningfully — there is no monotonic column on
          // frame_commands — so it only makes the order deterministic, not
          // insertion-ordered. Callers that need a strict order must enqueue
          // in separate statements.
          .orderBy(asc(frameCommands.createdAt), asc(frameCommands.id));
        for (const command of pending) {
          if (session.ws.readyState !== WebSocket.OPEN) {
            return;
          }
          // Backpressure: leave the rest queued (durable, still "pending")
          // rather than buffering commands for a device that is not reading.
          if (session.ws.bufferedAmount > maxBufferedBytes) {
            logWarn("device.drain_backpressure", {
              bufferedAmount: session.ws.bufferedAmount,
              frameId: session.frame.id,
            });
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
    // Anything still unacked well past its write is treated as lost.
    await redeliverSentCommands(
      session.frame.id,
      new Date(Date.now() - redeliverAfterMs),
    );
    await drainCommands(session);
  }

  async function activateDeviceSession(session: DeviceSession) {
    // Revocation can land between the Bearer check at upgrade and the end of
    // the challenge handshake; without this recheck the frame would be marked
    // connected until the next sweep, up to 30s later.
    if (await isFrameRevoked(session)) {
      logInfo("device.activate_revoked", { frameId: session.frame.id });
      session.ws.close(closeAuthFailed, "frame_revoked");
      return;
    }
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
        ...(isRecord(hello.states) && acceptState(frameId, hello.states)
          ? { lastState: hello.states }
          : {}),
        ...(isAcceptableChecksum(hello.scenes_checksum)
          ? { scenesChecksum: hello.scenes_checksum }
          : {}),
      })
      .where(eq(frames.id, frameId));

    await expireStaleCommands(frameId);
    // A fresh session cannot have written anything yet, so every command
    // still in "sent" belongs to a socket that died before acking: requeue it
    // all (cutoff = now) before counting what the device is about to receive.
    await redeliverSentCommands(frameId, now);
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

  // Size guard shared by hello/state: an oversized last_state is not just a
  // big row, it is re-selected and fanned out to every browser socket on the
  // account by each later broadcastFrameUpdate. Rejecting keeps the previous
  // (valid) state; see the comment on maxStateBytes for why we do not truncate.
  function acceptState(frameId: string, state: unknown) {
    if (withinJsonByteLimit(state, maxStateBytes)) {
      return true;
    }
    logWarn("device.state_too_large", { frameId, limit: maxStateBytes });
    return false;
  }

  // Checksums are hex digests; an over-long one is malformed, and storing a
  // truncated copy would leave the frame permanently "out of sync" in the UI.
  function acceptChecksum(frameId: string, value: unknown) {
    if (isAcceptableChecksum(value)) {
      return value;
    }
    if (typeof value === "string") {
      logWarn("device.checksum_too_large", { frameId, length: value.length });
    }
    return undefined;
  }

  async function handleSceneAck(
    session: DeviceSession,
    msg: Record<string, unknown>,
  ) {
    const checksum = acceptChecksum(session.frame.id, msg.checksum);
    // active_scene is merged into last_state, so it needs the same ceiling a
    // scene id gets everywhere else (256 chars, as in auth-web's
    // set_current_scene validation).
    const activeScene =
      typeof msg.active_scene === "string"
        ? msg.active_scene.slice(0, maxSceneIdChars)
        : undefined;
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
    const checksum = acceptChecksum(session.frame.id, rest.scenes_checksum);
    const now = new Date();
    await db
      .update(frames)
      .set({
        lastSeenAt: now,
        updatedAt: now,
        ...(acceptState(session.frame.id, lastState) ? { lastState } : {}),
        ...(typeof rest.frameos_version === "string"
          ? { frameosVersion: rest.frameos_version.slice(0, 64) }
          : {}),
        ...(checksum !== undefined ? { scenesChecksum: checksum } : {}),
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
    // Frequency cap, keyed on the frame (not the socket) so reconnecting does
    // not reset the window. Over the limit the batch is dropped, not queued:
    // logs are best-effort telemetry and the device already batches them.
    if (
      !checkMemoryRateLimit(`frame_logs:${session.frame.id}`, logBatchRateLimit)
        .allowed
    ) {
      logWarn("device.log_rate_limited", { frameId: session.frame.id });
      sendAckError(session, msg, "rate_limited");
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
    // Same reasoning as last_state: last_metrics is persisted and re-broadcast,
    // so an oversized sample is rejected rather than stored or truncated.
    if (!withinJsonByteLimit(metrics, maxMetricsBytes)) {
      logWarn("device.metrics_too_large", {
        frameId: session.frame.id,
        limit: maxMetricsBytes,
      });
      sendAckError(session, msg, "payload_too_large");
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

  async function handleAssets(
    session: DeviceSession,
    msg: Record<string, unknown>,
  ) {
    const entries = parseAssetEntries(msg.assets);
    const stored = await storeFrameAssetListing(
      db,
      session.frame.id,
      entries,
      msg.truncated === true,
    );
    if (!stored) {
      // Reject, never truncate: a listing that looks complete but is not
      // would quietly lie in the Assets panel forever.
      logWarn("device.assets_listing_too_large", {
        entries: entries.length,
        frameId: session.frame.id,
      });
    }
  }

  async function handleAssetChunk(
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
    const seq =
      typeof msg.seq === "number" && Number.isInteger(msg.seq) && msg.seq >= 0
        ? msg.seq
        : undefined;
    // A chunk carrying `error` aborts the stream; the partial file is useless.
    if (typeof msg.error === "string" || seq === undefined) {
      session.assetStreams.delete(commandId);
      return;
    }
    let stream = session.assetStreams.get(commandId);
    if (!stream || seq === 0) {
      if (seq !== 0) {
        // Mid-stream chunk for a stream we are not tracking (hub restarted,
        // or an earlier chunk was dropped): ignore; redelivery will re-stream.
        session.assetStreams.delete(commandId);
        return;
      }
      if (
        !stream &&
        session.assetStreams.size >= maxAssetStreamsPerSession
      ) {
        logWarn("device.asset_stream_limit", { frameId: session.frame.id });
        return;
      }
      // seq 0 always restarts: at-least-once delivery may re-send the whole
      // asset_get, and the device then re-streams from scratch.
      stream = {
        chunks: [],
        contentType:
          typeof msg.content_type === "string" &&
          msg.content_type.length > 0 &&
          msg.content_type.length <= 256
            ? msg.content_type
            : "application/octet-stream",
        nextSeq: 0,
        receivedBytes: 0,
      };
      session.assetStreams.set(commandId, stream);
    }
    if (seq !== stream.nextSeq) {
      logWarn("device.asset_chunk_out_of_order", {
        expected: stream.nextSeq,
        frameId: session.frame.id,
        got: seq,
      });
      session.assetStreams.delete(commandId);
      return;
    }
    const chunk = Buffer.from(
      typeof msg.data === "string" ? msg.data : "",
      "base64",
    );
    stream.receivedBytes += chunk.length;
    if (stream.receivedBytes > maxAssetFileBytes) {
      logWarn("device.asset_stream_too_large", {
        frameId: session.frame.id,
        limit: maxAssetFileBytes,
      });
      session.assetStreams.delete(commandId);
      return;
    }
    stream.chunks.push(chunk);
    stream.nextSeq += 1;
    if (msg.done !== true) {
      return;
    }
    session.assetStreams.delete(commandId);
    // The command row is the authority on what was requested: a device must
    // not be able to poison the cache for a path the provider never asked for.
    const [command] = await db
      .select({ payload: frameCommands.payload })
      .from(frameCommands)
      .where(
        and(
          eq(frameCommands.id, commandId),
          eq(frameCommands.frameId, session.frame.id),
          eq(frameCommands.type, "asset_get"),
        ),
      )
      .limit(1);
    const payload = isRecord(command?.payload) ? command.payload : undefined;
    const path = typeof payload?.path === "string" ? payload.path : "";
    if (!path) {
      return;
    }
    await storeFrameAssetFile(db, session.frame.id, {
      content: Buffer.concat(stream.chunks),
      contentType: stream.contentType,
      path,
      thumb: payload?.thumb === true,
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
        // Keep only the fields activateDeviceSession uses: the rest of a
        // pre-auth hello would otherwise be retained on the session (and a
        // hello may arrive before the signature is verified at all).
        session.hello = {
          ...(typeof msg.frameos_version === "string"
            ? { frameos_version: msg.frameos_version }
            : {}),
          ...(isRecord(msg.states) ? { states: msg.states } : {}),
          ...(typeof msg.scenes_checksum === "string"
            ? { scenes_checksum: msg.scenes_checksum }
            : {}),
        };
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
      case "assets":
        await handleAssets(session, msg);
        break;
      case "asset_chunk":
        await handleAssetChunk(session, msg);
        break;
      default:
        // Forward compatibility: unknown frame → provider types are ignored.
        break;
    }
  }

  function attachDeviceSocket(ws: WebSocket, frame: FrameRow, scopes: string[]) {
    const session: DeviceSession = {
      alive: true,
      assetStreams: new Map(),
      authTimeout: undefined,
      authed: false,
      closed: false,
      disconnectHandled: false,
      drainQueued: false,
      draining: false,
      frame,
      handling: Promise.resolve(),
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
      // One message at a time per session: handlers read-modify-write the
      // frames row and (for log_batch) re-select what they just inserted, so
      // interleaving two of them produces duplicate broadcasts and lost
      // updates. ws delivers messages in order; this keeps the handling in
      // that order too.
      session.handling = session.handling.then(() =>
        handleDeviceMessage(session, data).catch((error: unknown) => {
          logError("device.message_failed", {
            error: errorField(error),
            frameId: frame.id,
          });
        }),
      );
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
    session: BrowserSession,
  ) {
    const connection: BrowserConnection = {
      accountId: session.accountId,
      alive: true,
      tokenHash: session.tokenHash,
      ws,
    };
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

  // maxPayload caps inbound frames; ws would otherwise buffer and parse up to
  // 100 MiB from any authenticated peer. Oversized frames close the socket
  // with 1009 before the payload is handed to the application.
  const wss = new WebSocketServer({ maxPayload: maxPayloadBytes, noServer: true });

  const allowedBrowserOrigins = getAllowedBrowserOrigins();
  const maxConnections = getMaxConnections();
  let openConnections = 0;

  // One counter for both socket flavors: the cap is on this process's total
  // socket footprint, not on either surface alone.
  function trackConnection(ws: WebSocket) {
    openConnections += 1;
    ws.on("close", () => {
      openConnections -= 1;
    });
  }

  function rejectUpgrade(socket: Duplex, status: number, reason: string) {
    const text =
      status === 401
        ? "Unauthorized"
        : status === 403
          ? "Forbidden"
          : status === 429
            ? "Too Many Requests"
            : status === 503
              ? "Service Unavailable"
              : "Not Found";
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

    // Cheapest checks first, before any database work: a hard ceiling on live
    // sockets, then a per-IP throttle. Both run for every surface, including
    // paths that turn out to be 404s.
    if (openConnections >= maxConnections) {
      logWarn("upgrade.connection_limit", { limit: maxConnections });
      rejectUpgrade(socket, 503, "too_many_connections");
      return;
    }
    const clientIp = clientIpFromRequest(req);
    const limit = await checkSharedRateLimit(
      db,
      `frame_hub_upgrade:${clientIp}`,
      upgradeRateLimit,
    );
    if (!limit.allowed) {
      logWarn("upgrade.rate_limited", { clientIp });
      rejectUpgrade(socket, 429, "rate_limited");
      return;
    }

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
        trackConnection(ws);
        attachDeviceSocket(ws, frame, scopes);
      });
      return;
    }

    // Browser sockets authenticate with a cookie, and a WebSocket handshake is
    // not subject to CORS — without this check any site could open one in a
    // logged-in visitor's browser and read the account's live fleet telemetry.
    // Today the SameSite=Lax session cookie happens to prevent that; this
    // makes it true by construction instead of by accident.
    const browserPath =
      pathname === browserAccountPath || browserFramePathPattern.test(pathname);
    if (browserPath) {
      const origin = req.headers.origin;
      if (!isAllowedBrowserOrigin(origin, allowedBrowserOrigins)) {
        logWarn("browser.upgrade_bad_origin", { origin });
        rejectUpgrade(socket, 403, "forbidden_origin");
        return;
      }
    }

    // Fleet view: one socket for every frame the account owns, including
    // frames enrolled after the socket opened (membership is resolved per
    // event at broadcast time).
    if (pathname === browserAccountPath) {
      const session = await authenticateBrowserSession(db, req.headers.cookie);
      if (!session) {
        rejectUpgrade(socket, 401, "unauthorized");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        trackConnection(ws);
        attachBrowserSocket(ws, accountBrowserSockets, session.accountId, session);
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
      const session = await authenticateBrowserSession(db, req.headers.cookie);
      if (!session) {
        rejectUpgrade(socket, 401, "unauthorized");
        return;
      }
      const [frame] = await db
        .select({ accountId: frames.accountId, id: frames.id })
        .from(frames)
        .where(eq(frames.id, frameId))
        .limit(1);
      if (!frame || frame.accountId !== session.accountId) {
        // 403 either way; the not-found case stays indistinguishable so the
        // endpoint does not confirm which frame ids exist.
        rejectUpgrade(socket, 403, "forbidden");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        trackConnection(ws);
        attachBrowserSocket(ws, frameBrowserSockets, frameId, session);
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

  // Browser sockets authenticate once, at upgrade; a session revoked later
  // (logout, admin revoke, expiry) has to be noticed here or the socket keeps
  // streaming fleet telemetry forever. Devices already get kicked on
  // revocation — this is the browser equivalent.
  async function closeRevokedBrowserSockets() {
    const connections: BrowserConnection[] = [];
    for (const registry of [frameBrowserSockets, accountBrowserSockets]) {
      for (const set of registry.values()) {
        connections.push(...set);
      }
    }
    if (connections.length === 0) {
      return;
    }
    const live = await liveSessionHashes(
      db,
      [...new Set(connections.map((connection) => connection.tokenHash))],
    );
    for (const connection of connections) {
      if (!live.has(connection.tokenHash)) {
        logInfo("browser.session_revoked", { accountId: connection.accountId });
        connection.ws.close(closeAuthFailed, "session_revoked");
      }
    }
  }

  // Fallback sweep in case a NOTIFY was missed, plus global expiry of
  // pending/sent commands whose TTL passed while no one was draining them,
  // plus the browser-session revocation recheck.
  async function runSweep() {
    await expireStaleCommands();
    for (const session of deviceSessions.values()) {
      if (session.ready) {
        await wakeSession(session);
      }
    }
    await closeRevokedBrowserSockets();
  }

  const sweepTimer = setInterval(() => {
    runSweep().catch((error: unknown) =>
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
    sweep: runSweep,
  };
}
