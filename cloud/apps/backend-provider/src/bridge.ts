// The sidecar's internal API: what the self-hosted backend asks of the frame
// hub it runs next to (docs/convergence-todo.md item 7, Stage 1, option B).
//
// The hub itself is the cloud's, unmodified (cloud/apps/frame-hub): it serves
// /api/frames/ws on its own port and keeps everything durable in this
// sidecar's Postgres, the cloud's schema. On the cloud, auth-web talks to the
// hub through that database (frame_commands + NOTIFY); here the backend
// plays auth-web's part through this API instead, so Python never touches
// the cloud's schema and the TypeScript that validates and queues a verb is
// the cloud's own (auth-web src/lib/frames.ts, cloud-frames-contract.ts).
//
// Bound to 127.0.0.1 and gated by FRAMEOS_PROVIDER_BRIDGE_SECRET: only the
// backend in the same container may call it.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import {
  accounts,
  createDb,
  frameAssets,
  frameCommands,
  frameDeviceScenes,
  frames,
  linkedClients,
  sessions,
} from "@frameos-cloud/db";
import { readBlob } from "../../auth-web/src/lib/blobs";
import { checkContractSettings, contractVerbs } from "../../auth-web/src/lib/cloud-frames-contract";
import { cachedAssetFile } from "../../auth-web/src/lib/frame-asset-cache";
import {
  cancelFrameCommand,
  enqueueFrameCommand,
  frameCommandsNotifyChannel,
  frameContractProfile,
  frameSummary,
  listPendingFrameCommands,
  revokeFrame,
  supersedePendingCommands,
} from "../../auth-web/src/lib/frames";
import { derivedSigningKey } from "../../auth-web/src/lib/keys";
import { hashSecret } from "../../auth-web/src/lib/secrets";

type Db = ReturnType<typeof createDb>;

// One account holds every frame the backend is the provider of: the
// backend's projects are its own business, kept in the link metadata.
export const backendAccountName = "FrameOS backend";
const sessionTtlMs = 24 * 60 * 60 * 1000;
const maxBodyBytes = 6 * 1024 * 1024;
const verbTypes = new Set<string>(contractVerbs.map((verb) => verb.type));

export interface BridgeOptions {
  port: number;
  host?: string;
  secret: string;
  databaseUrl?: string;
}

export interface Bridge {
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
  ) {
    super(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new HttpError(413, "payload_too_large");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(value)) {
      throw new HttpError(400, "invalid_json");
    }
    return value;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid_json");
  }
}

function authorized(req: IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function stringField(body: Record<string, unknown>, key: string, max = 4096): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export async function backendAccountId(db: Db): Promise<string> {
  const [existing] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.displayName, backendAccountName))
    .limit(1);
  if (existing) {
    return existing.id;
  }
  const [created] = await db.insert(accounts).values({ displayName: backendAccountName }).returning({ id: accounts.id });
  if (!created) {
    throw new Error("could not create the backend account");
  }
  return created.id;
}

async function frameByBackendId(db: Db, backendFrameId: number) {
  const [row] = await db
    .select({ frame: frames, link: linkedClients })
    .from(frames)
    .innerJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
    .where(sql`${linkedClients.providerClientMetadata}->>'backendFrameId' = ${String(backendFrameId)}`)
    .limit(1);
  return row;
}

async function frameById(db: Db, frameId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(frameId)) {
    throw new HttpError(404, "frame_not_found");
  }
  const [row] = await db
    .select({ frame: frames, link: linkedClients })
    .from(frames)
    .innerJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
    .where(eq(frames.id, frameId))
    .limit(1);
  if (!row) {
    throw new HttpError(404, "frame_not_found");
  }
  return row;
}

// PUT /internal/frames/by-backend/:id — the backend enrolled (or re-keyed) a
// frame: the link token's hash and the device key it holds become this
// database's linked client and frame row, so the hub authenticates the
// device's socket exactly as the cloud would. A changed device key is the
// hub's cue to close a socket open under the old one (4401).
async function upsertFrame(db: Db, backendFrameId: number, body: Record<string, unknown>) {
  const tokenHash = stringField(body, "token_hash", 128);
  const publicKey = stringField(body, "public_key", 128);
  const name = stringField(body, "name", 256) ?? "FrameOS";
  const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [];
  if (!tokenHash || !publicKey) {
    throw new HttpError(400, "token_hash_and_public_key_required");
  }
  const hardware = isRecord(body.hardware) ? body.hardware : null;
  const version = stringField(body, "frameos_version", 64);
  const localOrigin = stringField(body, "local_origin", 512);
  const metadata = {
    backendFrameId,
    backendProjectId: typeof body.project_id === "number" ? body.project_id : null,
    requestedScopes: scopes,
  };
  const now = new Date();
  const existing = await frameByBackendId(db, backendFrameId);
  if (existing) {
    await db
      .update(linkedClients)
      .set({
        localOrigin: localOrigin ?? existing.link.localOrigin,
        providerClientMetadata: metadata,
        publicDisplayName: name,
        revokedAt: null,
        tokenReference: tokenHash,
        updatedAt: now,
      })
      .where(eq(linkedClients.id, existing.link.id));
    await db
      .update(frames)
      .set({
        frameosVersion: version ?? existing.frame.frameosVersion,
        hardware: hardware ?? existing.frame.hardware,
        name,
        publicKey,
        status: "active",
        updatedAt: now,
      })
      .where(eq(frames.id, existing.frame.id));
    if (existing.frame.publicKey !== publicKey || existing.link.tokenReference !== tokenHash) {
      await db.execute(sql`select pg_notify(${frameCommandsNotifyChannel}, ${existing.frame.id})`);
    }
    return { frame_id: existing.frame.id };
  }
  const accountId = await backendAccountId(db);
  return await db.transaction(async (tx) => {
    const [link] = await tx
      .insert(linkedClients)
      .values({
        accountId,
        clientKind: "frame",
        localOrigin,
        providerClientMetadata: metadata,
        publicDisplayName: name,
        tokenReference: tokenHash,
      })
      .returning({ id: linkedClients.id });
    if (!link) {
      throw new Error("could not create the linked client");
    }
    const [frame] = await tx
      .insert(frames)
      .values({
        accountId,
        frameosVersion: version,
        hardware,
        linkedClientId: link.id,
        name,
        publicKey,
        status: "active",
      })
      .returning({ id: frames.id });
    if (!frame) {
      throw new Error("could not create the frame");
    }
    return { frame_id: frame.id };
  });
}

// POST /internal/frames/:id/commands — one verb onto the hub's queue, through
// the cloud's enqueueFrameCommand (which also starts the deploy-progress
// record for a deploy, an update, a restart or a reboot, and NOTIFYs the
// hub). A set_settings is checked by the cloud's contract walker first: the
// device's own verdict, before anything is queued.
async function enqueueCommand(db: Db, frameId: string, body: Record<string, unknown>) {
  const { frame } = await frameById(db, frameId);
  const type = stringField(body, "type", 64);
  if (!type || !verbTypes.has(type)) {
    throw new HttpError(400, "unknown_verb");
  }
  const payload = isRecord(body.payload) ? { ...body.payload } : undefined;
  for (const key of Object.keys(payload ?? {})) {
    // Bookkeeping of the caller's never reaches the queue (or the device).
    if (key.startsWith("_")) {
      delete payload?.[key];
    }
  }
  if (type === "set_settings") {
    const verdict = checkContractSettings(payload?.settings, frameContractProfile(frame));
    if (verdict) {
      throw new HttpError(400, verdict);
    }
  }
  if (body.supersede === true) {
    await supersedePendingCommands(db, frameId, type);
  }
  const ttlMs = typeof body.ttl_ms === "number" && body.ttl_ms > 0 ? body.ttl_ms : undefined;
  const command = await enqueueFrameCommand(db, {
    frameId,
    type,
    ...(payload ? { payload } : {}),
    ...(ttlMs ? { ttlMs } : {}),
  });
  if (!command) {
    throw new Error("enqueue failed");
  }
  return commandView(command);
}

function commandView(command: typeof frameCommands.$inferSelect) {
  return {
    acked_at: command.ackedAt,
    created_at: command.createdAt,
    error: command.error,
    expires_at: command.expiresAt,
    id: command.id,
    sent_at: command.sentAt,
    status: command.status,
    type: command.type,
  };
}

async function commandStatus(db: Db, frameId: string, commandId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(commandId)) {
    throw new HttpError(404, "command_not_found");
  }
  const [command] = await db
    .select()
    .from(frameCommands)
    .where(and(eq(frameCommands.id, commandId), eq(frameCommands.frameId, frameId)))
    .limit(1);
  if (!command) {
    throw new HttpError(404, "command_not_found");
  }
  return commandView(command);
}

// POST /internal/session — a browser session for the backend's account, so
// the backend can follow the hub's fleet socket (/api/frames/updates: every
// update_frame, new_log, new_metrics of its frames) exactly as the
// workspace follows it on the cloud.
async function mintSession(db: Db) {
  const accountId = await backendAccountId(db);
  const now = Date.now();
  const token = await new SignJWT({ profile: { accountId } })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor((now + sessionTtlMs) / 1000))
    .setJti(randomUUID())
    .sign(derivedSigningKey("session"));
  const expiresAt = new Date(now + sessionTtlMs);
  await db.insert(sessions).values({
    absoluteExpiresAt: expiresAt,
    accountId,
    expiresAt,
    tokenHash: hashSecret(token),
  });
  return { cookie: `frameos_cloud_session=${token}`, expires_at: expiresAt.toISOString() };
}

async function route(db: Db, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://bridge");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";
  if (parts[0] !== "internal") {
    throw new HttpError(404, "not_found");
  }
  if (parts[1] === "healthz" && method === "GET") {
    return sendJson(res, 200, { ok: true });
  }
  if (parts[1] === "session" && method === "POST") {
    return sendJson(res, 200, await mintSession(db));
  }
  if (parts[1] !== "frames" || !parts[2]) {
    throw new HttpError(404, "not_found");
  }
  if (parts[2] === "by-backend" && parts[3] && parts.length === 4) {
    const backendFrameId = Number(parts[3]);
    if (!Number.isInteger(backendFrameId) || backendFrameId <= 0) {
      throw new HttpError(400, "invalid_frame_id");
    }
    if (method === "PUT") {
      return sendJson(res, 200, await upsertFrame(db, backendFrameId, await readJson(req)));
    }
    if (method === "GET") {
      const row = await frameByBackendId(db, backendFrameId);
      if (!row) {
        throw new HttpError(404, "frame_not_found");
      }
      return sendJson(res, 200, { frame_id: row.frame.id });
    }
  }
  const frameId = parts[2];
  const sub = parts[3];
  if (!sub && method === "GET") {
    const { frame, link } = await frameById(db, frameId);
    return sendJson(res, 200, {
      frame: { ...frameSummary(frame, link), last_metrics: frame.lastMetrics, last_state: frame.lastState },
    });
  }
  if (!sub && method === "DELETE") {
    const { frame } = await frameById(db, frameId);
    // The cloud's revocation (status, queue, NOTIFY: the hub closes a live
    // socket with 4401), then the rows go: the backend deleted the frame.
    await revokeFrame(db, { id: frame.id, linkedClientId: frame.linkedClientId });
    await db.delete(linkedClients).where(eq(linkedClients.id, frame.linkedClientId));
    return sendJson(res, 200, { ok: true });
  }
  if (sub === "commands") {
    const commandId = parts[4];
    if (!commandId && method === "POST") {
      return sendJson(res, 200, await enqueueCommand(db, frameId, await readJson(req)));
    }
    if (!commandId && method === "GET") {
      await frameById(db, frameId);
      return sendJson(res, 200, { commands: await listPendingFrameCommands(db, frameId) });
    }
    if (commandId && method === "GET") {
      return sendJson(res, 200, await commandStatus(db, frameId, commandId));
    }
    if (commandId && method === "DELETE") {
      const cancelled = await cancelFrameCommand(db, frameId, commandId);
      return sendJson(res, cancelled ? 200 : 404, cancelled ? { ok: true } : { error: "nothing_to_cancel" });
    }
  }
  if (sub === "assets" && method === "GET") {
    const [row] = await db.select().from(frameAssets).where(eq(frameAssets.frameId, frameId)).limit(1);
    if (!row) {
      throw new HttpError(404, "no_listing");
    }
    return sendJson(res, 200, { assets: row.payload, truncated: row.truncated, updated_at: row.updatedAt });
  }
  if (sub === "asset-file" && method === "GET") {
    const path = url.searchParams.get("path") ?? "";
    const thumb = url.searchParams.get("thumb") === "1";
    const row = await cachedAssetFile(db, frameId, path, thumb);
    const content = await readBlob(row);
    if (!row || !content) {
      throw new HttpError(404, "no_file");
    }
    res.writeHead(200, {
      "cache-control": "no-store",
      "content-type": row.contentType || "application/octet-stream",
      "x-updated-at": row.updatedAt.toISOString(),
    });
    res.end(content);
    return;
  }
  if (sub === "device-scenes") {
    const [row] = await db.select().from(frameDeviceScenes).where(eq(frameDeviceScenes.frameId, frameId)).limit(1);
    if (method === "GET") {
      if (!row || row.status !== "ready" || !row.payload) {
        throw new HttpError(404, "no_device_scenes");
      }
      res.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
      res.end(row.payload);
      return;
    }
    if (method === "POST" && parts[4] === "imported") {
      // Decided: the hub stops asking (shouldRequestDeviceScenes).
      await db
        .update(frameDeviceScenes)
        .set({ payload: null, status: "imported", statusAt: new Date() })
        .where(eq(frameDeviceScenes.frameId, frameId));
      return sendJson(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, "not_found");
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  if (!options.secret || options.secret.length < 16) {
    throw new Error("FRAMEOS_PROVIDER_BRIDGE_SECRET must be at least 16 characters");
  }
  const db = createDb(options.databaseUrl ?? process.env.DATABASE_URL);
  const server: Server = createServer((req, res) => {
    if (!authorized(req, options.secret)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    route(db, req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.error });
        return;
      }
      console.error("backend-provider bridge:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(() => server.closeAllConnections(), 250).unref();
      }),
    port: address && typeof address === "object" ? address.port : options.port,
  };
}
