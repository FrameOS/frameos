// Asset mutations for cloud-managed frames: enqueue a write verb
// (asset_put / asset_mkdir / asset_delete / asset_rename), wait for the
// device's ack, and keep the hub-side caches honest afterwards. The routes
// under app/api/frames/[frameId]/assets/* mirror the self-hosted backend's
// client contract so the shared SPA needs no cloud branch.

import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, like, or, sql } from "drizzle-orm";
import { frameAssetFiles, frameCommands } from "@frameos-cloud/db";
import type { NextRequest } from "next/server";
import { recordAuditEvent } from "./audit";
import { csrfResponse } from "./csrf";
import { jsonError, requireDatabase } from "./device-flow";
import {
  assetStoragePayload,
  commandAssetStorageIs,
  defaultAssetStorage,
  resolveAssetStorage,
} from "./frame-asset-storages";
import {
  enqueueFrameCommand,
  frameForAccount,
  supersedePendingCommands,
  type FramesDatabase,
} from "./frames";
import { rateLimitResponse } from "./rate-limit";
import { readSession } from "./session";

type CommandDatabase = Parameters<typeof enqueueFrameCommand>[0];

// Mirror of HubMaxAssetUploadBytes (frameos/src/frameos/cloud/hub_client.nim):
// a single-shot `asset_put` rides one base64-encoded WS frame under the
// device's 4 MiB inbound cap. Bigger files ride `asset_put_chunk` — see
// uploadAssetBytes — up to maxChunkedAssetUploadBytes.
export const maxAssetUploadBytes = 2_621_440;
// Mirror of HubMaxChunkedUploadBytes / FOS_CLOUD_ASSET_CHUNKED_MAX_BYTES: the
// assembled file's ceiling on the device.
export const maxChunkedAssetUploadBytes = 64 * 1024 * 1024;
// Raw bytes per asset_put_chunk. The ESP32 caps an inbound WS text frame at
// 512 KiB (FOS_CLOUD_WS_MAX_MSG), so 256 KiB raw (~342 KiB base64 plus
// envelope) is the most it can take; the Linux runtime takes 4 MiB frames,
// so 1 MiB raw keeps a 10 MB font at ten round-trips instead of forty.
export const esp32AssetUploadChunkBytes = 256 * 1024;
export const linuxAssetUploadChunkBytes = 1024 * 1024;

export function isEsp32Frame(frame: { hardware: unknown }): boolean {
  const platform = (frame.hardware as { platform?: unknown } | null)?.platform;
  return typeof platform === "string" && platform.toLowerCase().startsWith("esp32");
}

/** The biggest raw chunk this frame's firmware can take in one WS frame. */
export function assetUploadChunkBytes(frame: { hardware: unknown }): number {
  return isEsp32Frame(frame) ? esp32AssetUploadChunkBytes : linuxAssetUploadChunkBytes;
}

// upload_id becomes a filename component on the device: the same
// [A-Za-z0-9_-] alphabet secureToken()/randomUUID produce, bounded.
const uploadIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidUploadId(value: unknown): value is string {
  return typeof value === "string" && uploadIdPattern.test(value);
}

const commandTtlMs = 2 * 60 * 1000;
// Mutations are user-blocking (a dialog waits on them), so wait about as
// long as the asset long-poll does before calling the frame unreachable.
const ackTimeoutMs = 30_000;
const ackPollStepMs = 500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The filename the device will actually store, mirroring
 * sanitizeAssetComponent(extractFilename(...), "uploaded_file", allowDot) in
 * admin_api_assets_routes.nim — the ack's payload does not survive into
 * frame_commands, so the route predicts the stored path instead.
 */
export function sanitizedUploadFilename(filename: string): string {
  const base = filename.split("/").pop() ?? "";
  let safe = "";
  for (const ch of base) {
    safe += /[A-Za-z0-9._-]/.test(ch) ? ch : "_";
  }
  safe = safe.replace(/^[_.]+/, "").replace(/[_.]+$/, "");
  return safe.length > 0 ? safe : "uploaded_file";
}

/**
 * Mirror of the device's refusedWritePath: writes never touch dot-directories
 * (.thumbs, .frameos) — refusing here spares a queued command the device
 * would reject anyway.
 */
export function hiddenWritePath(path: string): boolean {
  return path
    .split("/")
    .some((component) => component.length > 0 && component.startsWith("."));
}

export type AssetCommandResult =
  | { ok: true }
  | { ok: false; error: string; timedOut?: boolean };

/**
 * Enqueue one write verb and long-poll its ack. Resolves ok on the device's
 * ack, with the device's wire error on refusal, and with timedOut when the
 * frame did not answer in time — the command stays queued, so a sleeping
 * frame still applies it on its next sync; the caller just cannot claim it
 * happened yet.
 */
export async function runAssetWriteCommand(
  db: CommandDatabase,
  accountId: string,
  frameId: string,
  type: "asset_put" | "asset_put_chunk" | "asset_mkdir" | "asset_delete" | "asset_rename",
  payload: Record<string, unknown>,
): Promise<AssetCommandResult> {
  const command = await enqueueFrameCommand(db, {
    createdByAccountId: accountId,
    frameId,
    payload,
    ttlMs: commandTtlMs,
    type,
  });
  if (!command) {
    return { ok: false, error: "command_not_queued" };
  }
  return waitForAssetCommand(db, command.id);
}

/** Long-poll one queued write verb's ack (runAssetWriteCommand's wait). */
async function waitForAssetCommand(
  db: CommandDatabase,
  commandId: string,
): Promise<AssetCommandResult> {
  const deadline = Date.now() + ackTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(ackPollStepMs);
    const [row] = await db
      .select({ error: frameCommands.error, status: frameCommands.status })
      .from(frameCommands)
      .where(eq(frameCommands.id, commandId))
      .limit(1);
    if (!row) {
      return { ok: false, error: "command_lost" };
    }
    if (row.status === "acked") {
      return { ok: true };
    }
    if (row.status === "failed" || row.status === "expired") {
      return { ok: false, error: row.error ?? "asset_write_failed" };
    }
  }
  return { ok: false, error: "frame_unreachable", timedOut: true };
}

/**
 * One `asset_put_chunk` toward the device: `bytes` land at `offset` in the
 * part named `uploadId`; with `finalPath` set the device commits the part
 * to that asset path. Wire contract in docs/cloud-frames.md. The device's
 * `chunk_gap` (an earlier chunk never landed — restart from offset 0) and a
 * firmware that predates the verb (`unknown_verb` / `unsupported_verb`, which
 * this maps to `chunked_upload_unsupported`) come back as ordinary errors for
 * the caller to act on.
 */
export async function putAssetChunk(
  db: CommandDatabase,
  accountId: string,
  frameId: string,
  chunk: {
    uploadId: string;
    offset: number;
    bytes: Uint8Array;
    finalPath?: string;
    storage?: string;
  },
): Promise<AssetCommandResult> {
  // A retry of a chunk whose request gave up (frame_unreachable after
  // ackTimeoutMs) while its command stayed queued: wait for that command
  // instead of sending the chunk again. A second copy only doubled what a
  // slow link carried, and a last chunk that landed late had already turned
  // the part into the file, so its copy came back chunk_gap and the browser
  // started the whole upload over.
  const earlier = await earlierChunkCommand(db, frameId, chunk);
  if (earlier?.status === "acked") {
    return { ok: true };
  }
  const result = earlier
    ? await waitForAssetCommand(db, earlier.id)
    : await runAssetWriteCommand(db, accountId, frameId, "asset_put_chunk", {
        upload_id: chunk.uploadId,
        offset: chunk.offset,
        data: Buffer.from(chunk.bytes).toString("base64"),
        ...(chunk.finalPath !== undefined ? { complete: true, path: chunk.finalPath } : {}),
        ...assetStoragePayload(chunk.storage ?? defaultAssetStorage),
      });
  if (!result.ok && (result.error === "unknown_verb" || result.error === "unsupported_verb")) {
    return { ok: false, error: "chunked_upload_unsupported" };
  }
  return result;
}

/**
 * The newest `asset_put_chunk` of this upload at this offset that is still on
 * its way or was acked, within a command's lifetime. An upload id is the
 * browser's for one file, so the same id and offset are the same bytes; a
 * refused or expired copy does not count, and the chunk goes again.
 */
async function earlierChunkCommand(
  db: CommandDatabase,
  frameId: string,
  chunk: { uploadId: string; offset: number; finalPath?: string },
): Promise<{ id: string; status: string } | undefined> {
  const [row] = await db
    .select({ id: frameCommands.id, status: frameCommands.status })
    .from(frameCommands)
    .where(
      and(
        eq(frameCommands.frameId, frameId),
        eq(frameCommands.type, "asset_put_chunk"),
        inArray(frameCommands.status, ["pending", "sent", "acked"]),
        gt(frameCommands.createdAt, new Date(Date.now() - commandTtlMs)),
        sql`${frameCommands.payload} ->> 'upload_id' = ${chunk.uploadId}`,
        sql`${frameCommands.payload} ->> 'offset' = ${String(chunk.offset)}`,
        chunk.finalPath !== undefined
          ? sql`${frameCommands.payload} ->> 'path' = ${chunk.finalPath}`
          : sql`${frameCommands.payload} ->> 'complete' is null`,
      ),
    )
    .orderBy(desc(frameCommands.createdAt))
    .limit(1);
  return row;
}

/**
 * Put a whole file on the device, whichever way its size allows: one
 * `asset_put` when it fits a single WS frame (older firmware included),
 * otherwise `asset_put_chunk` after `asset_put_chunk`, each acked before the
 * next goes out — one payload in flight, and a frame that goes away stops
 * the run early. A `chunk_gap` restarts the file once under a fresh id.
 * `onChunk` reports bytes acked so far, for callers streaming progress.
 */
export async function uploadAssetBytes(
  db: CommandDatabase,
  accountId: string,
  frame: { id: string; hardware: unknown },
  path: string,
  bytes: Uint8Array,
  options: {
    onChunk?: (ackedBytes: number) => void;
    /**
     * The caller's request signal. Checked before every chunk: once the
     * browser has gone, no further chunk is queued toward the device (a
     * chunk already in flight still completes — its command is queued and
     * the device will ack it). Answers `aborted`, never throws.
     */
    signal?: AbortSignal;
    /** Which of the device's storages (frame-asset-storages.ts). */
    storage?: string;
  } = {},
): Promise<AssetCommandResult> {
  const storage = options.storage ?? defaultAssetStorage;
  if (bytes.length > maxChunkedAssetUploadBytes) {
    return { ok: false, error: "too_large" };
  }
  if (options.signal?.aborted) {
    return { ok: false, error: "aborted" };
  }
  if (bytes.length <= maxAssetUploadBytes) {
    return runAssetWriteCommand(db, accountId, frame.id, "asset_put", {
      data: Buffer.from(bytes).toString("base64"),
      path,
      ...assetStoragePayload(storage),
    });
  }
  const chunkBytes = assetUploadChunkBytes(frame);
  let restartsLeft = 1;
  let uploadId = randomUUID().replace(/-/g, "");
  let offset = 0;
  while (offset < bytes.length) {
    if (options.signal?.aborted) {
      return { ok: false, error: "aborted" };
    }
    const end = Math.min(bytes.length, offset + chunkBytes);
    const result = await putAssetChunk(db, accountId, frame.id, {
      uploadId,
      offset,
      bytes: bytes.subarray(offset, end),
      ...(end >= bytes.length ? { finalPath: path } : {}),
      storage,
    });
    if (result.ok) {
      offset = end;
      options.onChunk?.(offset);
      continue;
    }
    if (result.error === "chunk_gap" && restartsLeft > 0) {
      restartsLeft -= 1;
      uploadId = randomUUID().replace(/-/g, "");
      offset = 0;
      continue;
    }
    return result;
  }
  return { ok: true };
}

/**
 * Drop cached file bytes for a path (both thumb variants) and, for
 * directories, everything under it — after a delete or rename the cache
 * would otherwise keep serving the old bytes for up to the staleness window.
 */
export async function invalidateCachedAssetSubtree(
  db: FramesDatabase,
  frameId: string,
  path: string,
  storage: string = defaultAssetStorage,
) {
  // Escape LIKE metacharacters in the path so "10%" or "a_b" folders do not
  // widen the invalidation to unrelated rows.
  const prefix = path.replace(/([\\%_])/g, "\\$1");
  await db
    .delete(frameAssetFiles)
    .where(
      and(
        eq(frameAssetFiles.frameId, frameId),
        eq(frameAssetFiles.storage, storage),
        or(
          eq(frameAssetFiles.path, path),
          like(frameAssetFiles.path, `${prefix}/%`),
        ),
      ),
    );
}

/**
 * The shared guard rail for every asset mutation route: CSRF, rate limit,
 * session, database, frame ownership, and the frame being active. Returns
 * either an error response to relay or the context to work with.
 */
// Budgets for the write routes. A whole-file write (one asset_put, an mkdir,
// a rename) is a user action and gets the tight window; a continuation chunk
// of an upload already under way is one of many hundreds for a single file
// (256 KiB each on the ESP32), so the same 120 would have refused a 40 MB
// file at chunk 121 while the route advertises 60 MB. The chunk window is
// sized for the advertised cap at the smallest chunk with headroom.
export const assetWriteRateLimit = { limit: 120, windowMs: 15 * 60 * 1000 };
export const assetChunkRateLimit = { limit: 2400, windowMs: 15 * 60 * 1000 };

export async function assetWriteRequestContext(
  request: NextRequest,
  frameId: string,
  options: { rateLimit?: { limit: number; windowMs: number }; rateLimitKey?: string } = {},
): Promise<
  | { response: Response }
  | {
      response?: undefined;
      db: CommandDatabase;
      accountId: string;
      actor: { accountId: string; providerSubject?: string };
      frame: NonNullable<Awaited<ReturnType<typeof frameForAccount>>>;
      // The `storage` query parameter, checked (resolveAssetStorage).
      storage: string;
    }
> {
  const csrf = csrfResponse(request);
  if (csrf) {
    return { response: csrf };
  }
  const limited = await rateLimitResponse(
    request,
    options.rateLimitKey ?? "frames:asset_write",
    options.rateLimit ?? assetWriteRateLimit,
  );
  if (limited) {
    return { response: limited };
  }
  const session = await readSession();
  if (!session?.accountId) {
    return { response: jsonError("login_required", 401) };
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return { response: response! };
  }
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return { response: jsonError("invalid_frame", 404) };
  }
  if (frame.status !== "active") {
    return { response: jsonError("frame_not_active", 409) };
  }
  const storage = await resolveAssetStorage(
    db,
    frame.id,
    request.nextUrl.searchParams.get("storage"),
  );
  if (!storage.ok) {
    return { response: jsonError(storage.error, storage.status) };
  }
  return {
    db,
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    frame,
    storage: storage.storage,
  };
}

export type AssetAuditEventType =
  | "frame.asset_uploaded"
  | "frame.asset_deleted"
  | "frame.asset_mkdir"
  | "frame.asset_renamed"
  | "frame.assets_synced";

/**
 * Audit a write the device acked. Paths and counts only — never bytes or
 * file names beyond the path the owner typed — so the activity feed can say
 * *what* changed on the frame without becoming a copy of the asset.
 */
export async function recordAssetWriteAudit(
  db: CommandDatabase,
  context: {
    accountId: string;
    actor: { accountId: string; providerSubject?: string };
    frame: { id: string };
  },
  eventType: AssetAuditEventType,
  metadata: Record<string, unknown>,
) {
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: context.actor,
    eventType,
    metadata,
    target: { frameId: context.frame.id },
  });
}

/**
 * The metadata of an asset write's audit row: what the route recorded,
 * plus the storage when it is not the default (so the activity feed's
 * existing rows and new default-storage rows read the same).
 */
export function assetAuditMetadata(
  storage: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return { ...metadata, ...assetStoragePayload(storage) };
}

/** Map a device refusal / queue outcome onto an HTTP error response. */
export function assetWriteErrorResponse(
  result: Extract<AssetCommandResult, { ok: false }>,
) {
  if (result.timedOut) {
    return jsonError(result.error, 504);
  }
  const status =
    result.error === "not_found"
      ? 404
      : result.error === "too_large"
        ? 413
        : result.error === "chunk_gap"
          ? 409
          : 400;
  return jsonError(result.error, status);
}

/**
 * Queue a fresh assets_list of the written storage so the panel's next
 * refresh shows the change. Only that storage's pending listing is
 * superseded: the other storage's is still somebody's question.
 */
export async function queueAssetsListRefresh(
  db: CommandDatabase,
  accountId: string,
  frameId: string,
  storage: string = defaultAssetStorage,
) {
  await supersedePendingCommands(db, frameId, "assets_list", commandAssetStorageIs(storage));
  const payload = assetStoragePayload(storage);
  await enqueueFrameCommand(db, {
    createdByAccountId: accountId,
    frameId,
    ...(payload.storage ? { payload } : {}),
    ttlMs: commandTtlMs,
    type: "assets_list",
  });
}
