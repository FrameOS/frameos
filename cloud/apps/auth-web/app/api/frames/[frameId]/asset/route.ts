import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { frameAssetFiles, frameCommands } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import {
  enqueueFrameCommand,
  frameForAccount,
  maxAssetPathChars,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

const fetchCommandTtlMs = 2 * 60 * 1000;
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

// Relative, bounded, no traversal — the device re-validates independently
// (resolveAssetPath on the Nim side), this just refuses obvious garbage
// before it costs a queued command.
function normalizeAssetPath(raw: string): string | undefined {
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

// RFC 6266 without the ceremony: allowlist instead of stripping — anything
// that could escape the quotes (quotes, backslashes, control characters)
// becomes an underscore.
function contentDisposition(kind: "attachment" | "inline", filename: string) {
  const safe = filename.replace(/[^\w. -]/g, "_").slice(0, 255);
  return `${kind}; filename="${safe || "asset"}"`;
}

type Db = NonNullable<ReturnType<typeof requireDatabase>["db"]>;

async function cachedAssetFile(
  db: Db,
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

async function outstandingFetch(
  db: Db,
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
  return rows.find((row) => {
    const payload =
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : {};
    return payload.path === path && (payload.thumb === true) === thumb;
  });
}

function assetResponse(
  row: { content: Buffer; contentType: string; sizeBytes: number },
  mode: string | null,
  filename: string | null,
) {
  const headers: Record<string, string> = {
    // Private: these bytes came off a specific user's frame. The browser may
    // keep them briefly so a re-render does not re-download every thumbnail.
    "cache-control": "private, max-age=60",
    "content-length": String(row.sizeBytes),
    "content-type": row.contentType || "application/octet-stream",
  };
  if (mode === "download") {
    headers["content-disposition"] = contentDisposition(
      "attachment",
      filename ?? "asset",
    );
  } else if (filename) {
    headers["content-disposition"] = contentDisposition("inline", filename);
  }
  return new NextResponse(new Uint8Array(row.content), { headers });
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
  const needsFetch =
    !cached || now - cached.updatedAt.getTime() > cacheStaleAfterMs;
  if (needsFetch && frame.status === "active") {
    if (!(await outstandingFetch(db, frame.id, path, thumb))) {
      await enqueueFrameCommand(db, {
        createdByAccountId: session.accountId,
        frameId: frame.id,
        payload: { path, ...(thumb ? { thumb: true } : {}) },
        ttlMs: fetchCommandTtlMs,
        type: "asset_get",
      });
    }
  }
  if (cached) {
    // Stale-while-revalidate: the refresh (if any) was queued above and the
    // next request picks up the new bytes.
    return assetResponse(cached, mode, filename);
  }
  if (frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }

  const deadline = now + longPollTotalMs;
  while (Date.now() < deadline) {
    await sleep(longPollStepMs);
    const row = await cachedAssetFile(db, frame.id, path, thumb);
    if (row) {
      return assetResponse(row, mode, filename);
    }
    // The device may have refused (not_found, too_large…): the command then
    // sits failed with an error, and waiting out the clock would just hold
    // the connection open for nothing. Only THIS path's recent command
    // counts — an old failure for some other file must not poison every
    // later request for this frame.
    const failedCommands = await db
      .select({ error: frameCommands.error, payload: frameCommands.payload })
      .from(frameCommands)
      .where(
        and(
          eq(frameCommands.frameId, frame.id),
          eq(frameCommands.type, "asset_get"),
          eq(frameCommands.status, "failed"),
          gt(frameCommands.createdAt, new Date(now - 60_000)),
        ),
      );
    const refused = failedCommands.find((row) => {
      const payload =
        row.payload && typeof row.payload === "object"
          ? (row.payload as Record<string, unknown>)
          : {};
      return payload.path === path && (payload.thumb === true) === thumb;
    });
    if (refused) {
      return jsonError(refused.error ?? "asset_fetch_failed", 404);
    }
  }
  return jsonError("asset_unavailable", 504);
}
