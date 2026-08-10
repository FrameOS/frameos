// Asset mutations for cloud-managed frames: enqueue a write verb
// (asset_put / asset_mkdir / asset_delete / asset_rename), wait for the
// device's ack, and keep the hub-side caches honest afterwards. The routes
// under app/api/frames/[frameId]/assets/* mirror the self-hosted backend's
// client contract so the shared SPA needs no cloud branch.

import { and, eq, like, or } from "drizzle-orm";
import { frameAssetFiles, frameCommands } from "@frameos-cloud/db";
import type { NextRequest } from "next/server";
import { csrfResponse } from "./csrf";
import { jsonError, requireDatabase } from "./device-flow";
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
// an upload rides a single base64-encoded WS frame under the device's 4 MiB
// inbound cap. Bigger files need a chunked verb that does not exist yet.
export const maxAssetUploadBytes = 2_621_440;

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
  type: "asset_put" | "asset_mkdir" | "asset_delete" | "asset_rename",
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
  const deadline = Date.now() + ackTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(ackPollStepMs);
    const [row] = await db
      .select({ error: frameCommands.error, status: frameCommands.status })
      .from(frameCommands)
      .where(eq(frameCommands.id, command.id))
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
 * Drop cached file bytes for a path (both thumb variants) and, for
 * directories, everything under it — after a delete or rename the cache
 * would otherwise keep serving the old bytes for up to the staleness window.
 */
export async function invalidateCachedAssetSubtree(
  db: FramesDatabase,
  frameId: string,
  path: string,
) {
  // Escape LIKE metacharacters in the path so "10%" or "a_b" folders do not
  // widen the invalidation to unrelated rows.
  const prefix = path.replace(/([\\%_])/g, "\\$1");
  await db
    .delete(frameAssetFiles)
    .where(
      and(
        eq(frameAssetFiles.frameId, frameId),
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
export async function assetWriteRequestContext(
  request: NextRequest,
  frameId: string,
): Promise<
  | { response: Response }
  | {
      response?: undefined;
      db: CommandDatabase;
      accountId: string;
      frame: NonNullable<Awaited<ReturnType<typeof frameForAccount>>>;
    }
> {
  const csrf = csrfResponse(request);
  if (csrf) {
    return { response: csrf };
  }
  const limited = await rateLimitResponse(request, "frames:asset_write", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
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
  return { db, accountId: session.accountId, frame };
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
        : 400;
  return jsonError(result.error, status);
}

/** Queue a fresh assets_list so the panel's next refresh shows the change. */
export async function queueAssetsListRefresh(
  db: CommandDatabase,
  accountId: string,
  frameId: string,
) {
  await supersedePendingCommands(db, frameId, "assets_list");
  await enqueueFrameCommand(db, {
    createdByAccountId: accountId,
    frameId,
    ttlMs: commandTtlMs,
    type: "assets_list",
  });
}
