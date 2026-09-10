import { NextRequest, NextResponse } from "next/server";
import { readBlob } from "../../../../../src/lib/blobs";
import {
  readOnlyTokenError,
  sessionMayQueueDeviceCommands,
} from "../../../../../src/lib/device-command-access";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import {
  assetFetchCommandTtlMs,
  cachedAssetFile,
  isServableImageContentType,
  normalizeAssetPath,
  queueAssetGetIfIdle,
  recentFailedAssetGet,
} from "../../../../../src/lib/frame-asset-cache";
import { commandTtlForFrame, frameIsAsleep } from "../../../../../src/lib/frame-sleep";
import { frameForAccount } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// A cached copy this old is re-requested in the background on the next hit;
// the stale bytes still serve immediately (assets on a frame rarely change,
// and a sleeping battery frame must not block every thumbnail).
const cacheStaleAfterMs = 15 * 60 * 1000;
// How long a cache miss waits for the device before giving up. Bounded by
// what a browser tolerates for an <img>; the panel shows a placeholder on
// failure and the fetched bytes land in the cache for the next attempt.
const longPollTotalMs = 25_000;
const longPollStepMs = 750;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// RFC 6266 without the ceremony: allowlist instead of stripping — anything
// that could escape the quotes (quotes, backslashes, control characters)
// becomes an underscore.
function contentDisposition(kind: "attachment" | "inline", filename: string) {
  const safe = filename.replace(/[^\w. -]/g, "_").slice(0, 255);
  return `${kind}; filename="${safe || "asset"}"`;
}

async function assetResponse(
  row: {
    content: Buffer | null;
    contentType: string;
    objectKey: string | null;
    sizeBytes: number;
  },
  mode: string | null,
  filename: string | null,
) {
  const content = await readBlob(row);
  if (!content) {
    return jsonError("asset_fetch_failed", 404);
  }
  // The bytes came off a device, and the device's word on what they are was
  // never taken (cachedAssetContentType sniffs raster images and stores
  // everything else as opaque). Belt and braces here: only a sniffed image
  // type is ever served with a rendering type, and anything else leaves the
  // app origin as a download — the device must not be able to hand a
  // browser a same-origin HTML or script document.
  const isImage = isServableImageContentType(row.contentType);
  const headers: Record<string, string> = {
    // Private: these bytes came off a specific user's frame. The browser may
    // keep them briefly so a re-render does not re-download every thumbnail.
    "cache-control": "private, max-age=60",
    "content-length": String(row.sizeBytes),
    "content-security-policy": "sandbox",
    "content-type": isImage ? row.contentType : "application/octet-stream",
    "x-content-type-options": "nosniff",
  };
  if (mode === "download" || !isImage) {
    headers["content-disposition"] = contentDisposition(
      "attachment",
      filename ?? "asset",
    );
  } else if (filename) {
    headers["content-disposition"] = contentDisposition("inline", filename);
  }
  return new NextResponse(new Uint8Array(content), { headers });
}

// One asset's bytes, in the shape the shared SPA's frameAssetUrl() requests:
// ?path=…[&thumb=1][&mode=download|image][&filename=…]. Serves the hub's
// cached copy when there is one (refreshing it in the background once it is
// stale) and otherwise queues an `asset_get` for the device and waits — the
// long poll is what lets a plain <img src> work against a device that has to
// be asked over a WebSocket.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:asset", {
    limit: 1200,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }

  const query = request.nextUrl.searchParams;
  const path = normalizeAssetPath(query.get("path") ?? "");
  if (!path) {
    return jsonError("invalid_path", 400);
  }
  const thumb = query.get("thumb") === "1";
  const mode = query.get("mode");
  const filename = query.get("filename");

  const cached = await cachedAssetFile(db, frame.id, path, thumb);
  const now = Date.now();
  // A stale copy is only refreshed behind the response while the frame is
  // on the socket: a sleeping or offline frame changes nothing on its card,
  // so the cached bytes are still exactly what is there, and queueing a
  // fetch per thumbnail toward it only fills the command queue until it
  // wakes. A cache miss still queues regardless — the person asked for
  // this file, and the sleep-aware TTL lets the device answer on its next
  // wake.
  const needsFetch =
    !cached ||
    (frame.connected &&
      now - cached.updatedAt.getTime() > cacheStaleAfterMs);
  const mayQueue = sessionMayQueueDeviceCommands(session);
  if (needsFetch && frame.status === "active" && mayQueue) {
    await queueAssetGetIfIdle(
      db,
      session.accountId,
      frame.id,
      path,
      thumb,
      commandTtlForFrame(frame, assetFetchCommandTtlMs, now),
    );
  }
  if (cached) {
    // Stale-while-revalidate: the refresh (if any) was queued above and the
    // next request picks up the new bytes.
    return await assetResponse(cached, mode, filename);
  }
  if (frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }
  if (!mayQueue) {
    // Nothing cached and only the device could answer: a read-only token
    // does not get to ask it (sessionMayQueueDeviceCommands).
    return jsonError(readOnlyTokenError, 403);
  }
  // The fetch is queued (with the sleep-aware TTL) for the device's next
  // session, but nobody should hold the connection open for it now: an
  // offline or sleeping frame answers in minutes or hours, not within the
  // poll window, and a panel of thumbnails toward such a frame used to pin
  // one 25 s request per <img> for nothing. 503 + Retry-After is the honest
  // answer; the browser shows its placeholder and the next visit finds the
  // bytes in the cache.
  if (!frame.connected || frameIsAsleep(frame, now)) {
    return NextResponse.json(
      { error: "frame_offline" },
      { headers: { "retry-after": "60" }, status: 503 },
    );
  }

  const deadline = now + longPollTotalMs;
  while (Date.now() < deadline) {
    await sleep(longPollStepMs);
    const row = await cachedAssetFile(db, frame.id, path, thumb);
    if (row) {
      return await assetResponse(row, mode, filename);
    }
    // The device may have refused (not_found, too_large…): the command then
    // sits failed with an error, and waiting out the clock would just hold
    // the connection open for nothing. Only THIS path's recent command
    // counts — an old failure for some other file must not poison every
    // later request for this frame.
    const refused = await recentFailedAssetGet(
      db,
      frame.id,
      path,
      thumb,
      60_000,
    );
    if (refused) {
      return jsonError(refused.error ?? "asset_fetch_failed", 404);
    }
  }
  return jsonError("asset_unavailable", 504);
}
