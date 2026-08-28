// The hub's device-asset cache, shared by the routes that read it: one row
// per (frame, path, thumb) in frame_asset_files, filled by asset_get /
// image_get chunk streams (frame-hub handleAssetChunk) and pruned LRU by
// storeFrameAssetFile. The /asset route serves arbitrary device files from
// it; the /scene_images route uses it for the device's own per-scene
// snapshots. Kept out of frames.ts (device write path) on purpose.

import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { frameAssetFiles, frameCommands } from "@frameos-cloud/db";
import {
  enqueueFrameCommand,
  maxAssetPathChars,
  type FramesDatabase,
} from "./frames";

// For an AWAKE frame. A sleeping frame's fetch has to outlive its sleep:
// callers pass commandTtlForFrame(frame, assetFetchCommandTtlMs) instead
// (frame-sleep.ts) — a 2-minute TTL on a 15-minute sleeper expired every
// single time, which is how a frame's image stayed stale for days.
export const assetFetchCommandTtlMs = 2 * 60 * 1000;

/**
 * Relative, bounded, no traversal — the device re-validates independently
 * (resolveAssetPath on the Nim side), this just refuses obvious garbage
 * before it costs a queued command.
 */
export function normalizeAssetPath(raw: string): string | undefined {
  let path = raw.trim();
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  while (path.startsWith("/")) {
    path = path.slice(1);
  }
  if (
    path.length === 0 ||
    path.length > maxAssetPathChars ||
    path.split("/").includes("..")
  ) {
    return undefined;
  }
  return path;
}

export async function cachedAssetFile(
  db: FramesDatabase,
  frameId: string,
  path: string,
  thumb: boolean,
) {
  const [row] = await db
    .select()
    .from(frameAssetFiles)
    .where(
      and(
        eq(frameAssetFiles.frameId, frameId),
        eq(frameAssetFiles.path, path),
        eq(frameAssetFiles.thumb, thumb),
      ),
    )
    .limit(1);
  return row;
}

function payloadMatches(
  payload: unknown,
  path: string,
  thumb: boolean,
): boolean {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  return record.path === path && (record.thumb === true) === thumb;
}

export async function outstandingAssetGet(
  db: FramesDatabase,
  frameId: string,
  path: string,
  thumb: boolean,
) {
  // Payload equality is checked in JS: the handful of live asset_get rows per
  // frame does not justify a jsonb index.
  const rows = await db
    .select({ id: frameCommands.id, payload: frameCommands.payload })
    .from(frameCommands)
    .where(
      and(
        eq(frameCommands.frameId, frameId),
        eq(frameCommands.type, "asset_get"),
        inArray(frameCommands.status, ["pending", "sent"]),
        or(
          isNull(frameCommands.expiresAt),
          gt(frameCommands.expiresAt, new Date()),
        ),
      ),
    );
  return rows.find((row) => payloadMatches(row.payload, path, thumb));
}

/**
 * A recent `failed` asset_get for this exact path+thumb — the device refused
 * (not_found, too_large, …). Callers use it to stop long-polling early and to
 * avoid re-queueing a fetch the device just said no to.
 */
export async function recentFailedAssetGet(
  db: FramesDatabase,
  frameId: string,
  path: string,
  thumb: boolean,
  withinMs: number,
) {
  const rows = await db
    .select({ error: frameCommands.error, payload: frameCommands.payload })
    .from(frameCommands)
    .where(
      and(
        eq(frameCommands.frameId, frameId),
        eq(frameCommands.type, "asset_get"),
        eq(frameCommands.status, "failed"),
        gt(frameCommands.createdAt, new Date(Date.now() - withinMs)),
      ),
    );
  return rows.find((row) => payloadMatches(row.payload, path, thumb));
}

/** Queue an asset_get unless an equivalent one is already in flight. */
export async function queueAssetGetIfIdle(
  db: Parameters<typeof enqueueFrameCommand>[0],
  accountId: string,
  frameId: string,
  path: string,
  thumb: boolean,
  ttlMs: number = assetFetchCommandTtlMs,
) {
  if (await outstandingAssetGet(db, frameId, path, thumb)) {
    return;
  }
  await enqueueFrameCommand(db, {
    createdByAccountId: accountId,
    frameId,
    payload: { path, ...(thumb ? { thumb: true } : {}) },
    ttlMs,
    type: "asset_get",
  });
}

/** A live (pending or sent, unexpired) image_get for this frame. */
export async function outstandingImageGet(db: FramesDatabase, frameId: string) {
  const [row] = await db
    .select({ id: frameCommands.id })
    .from(frameCommands)
    .where(
      and(
        eq(frameCommands.frameId, frameId),
        eq(frameCommands.type, "image_get"),
        inArray(frameCommands.status, ["pending", "sent"]),
        or(
          isNull(frameCommands.expiresAt),
          gt(frameCommands.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Queue an image_get (the frame's current rendered image, cached under
 * frameImageAssetPath) unless one is already in flight. The route behind the
 * preview panel and the hub's `render` handler (for devices whose image is
 * their framebuffer, not a snapshot file) both go through here.
 */
export async function queueImageGetIfIdle(
  db: Parameters<typeof enqueueFrameCommand>[0],
  accountId: string,
  frameId: string,
  ttlMs: number = assetFetchCommandTtlMs,
) {
  if (await outstandingImageGet(db, frameId)) {
    return false;
  }
  await enqueueFrameCommand(db, {
    createdByAccountId: accountId,
    frameId,
    ttlMs,
    type: "image_get",
  });
  return true;
}

/**
 * Where the device keeps its own snapshot of a scene, relative to its assets
 * root. Byte-for-byte mirror of sceneImageFilename in
 * frameos/src/frameos/scenes.nim — the runner writes
 * {assets}/.frameos/scene_images/{sanitized}-{md5(publicId)}.png on the first
 * render of each scene and on every scene switch, and asset_get can read it
 * (the dot-directory is hidden from assets_list, not from asset_get).
 * Runtime scene ids arrive both bare and as "uploaded/<id>"; the device
 * strips the prefix, so we do too.
 */
export function sceneSnapshotAssetPath(sceneId: string): string {
  const uploadedPrefix = "uploaded/";
  const publicId = sceneId.startsWith(uploadedPrefix)
    ? sceneId.slice(uploadedPrefix.length)
    : sceneId;
  let safe = "";
  for (const ch of publicId) {
    safe += /[A-Za-z0-9._-]/.test(ch) ? ch : "_";
  }
  safe = safe.replace(/^[_.-]+/, "").replace(/[_.-]+$/, "");
  if (safe.length === 0) {
    safe = "scene";
  }
  if (safe.length > 64) {
    safe = safe.slice(0, 64);
  }
  const digest = createHash("md5").update(publicId).digest("hex");
  return `.frameos/scene_images/${safe}-${digest}.png`;
}
