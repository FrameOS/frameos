import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { frameAssetFiles, frameCommands } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import {
  enqueueFrameCommand,
  frameForAccount,
  frameImageAssetPath,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

const fetchCommandTtlMs = 2 * 60 * 1000;
// The preview panel wants "the current image" — anything older than a
// render interval is history. A passive load (?t=-1, a tile filling in)
// serves stale immediately and refreshes behind it; an explicit refresh
// (?t=<seconds> — the refresh button, or a render signal) waits for the
// device's answer before falling back to the stale copy. Serving the same
// stale bytes to the very click that asked for fresh ones is how the
// refresh button reads as broken.
const imageStaleAfterMs = 30_000;
const longPollTotalMs = 25_000;
const longPollStepMs = 750;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Db = NonNullable<ReturnType<typeof requireDatabase>["db"]>;

async function cachedImage(db: Db, frameId: string) {
  const [row] = await db
    .select()
    .from(frameAssetFiles)
    .where(
      and(
        eq(frameAssetFiles.frameId, frameId),
        eq(frameAssetFiles.path, frameImageAssetPath),
        eq(frameAssetFiles.thumb, false),
      ),
    )
    .limit(1);
  return row;
}

async function outstandingImageGet(db: Db, frameId: string) {
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

function imageResponse(row: { content: Buffer; contentType: string }) {
  return new NextResponse(new Uint8Array(row.content), {
    headers: {
      // The panel cache-busts with ?t=…; the bytes themselves must not stick.
      "cache-control": "no-store",
      "content-type": row.contentType || "application/octet-stream",
    },
  });
}

// The frame's current rendered image — the exact route the shared SPA's
// preview panel already polls (cloud/docs/cloud-workspace-gaps.md item 1).
// Backed by the `image_get` verb: the device streams its last render (PNG on
// Linux, BMP straight from the ESP32 framebuffer) as asset_chunk frames and
// the hub caches it under a reserved dot-path in frame_asset_files.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:image", {
    limit: 600,
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

  const cached = await cachedImage(db, frame.id);
  const now = Date.now();
  // ?t=-1 is the tile's initial cache-only load (entityImagesModel); any
  // real timestamp means someone deliberately asked for the current image.
  const tParam = request.nextUrl.searchParams.get("t");
  const wantsFresh = tParam !== null && tParam !== "-1";
  const needsFetch =
    !cached || now - cached.updatedAt.getTime() > imageStaleAfterMs;
  if (
    needsFetch &&
    frame.status === "active" &&
    !(await outstandingImageGet(db, frame.id))
  ) {
    await enqueueFrameCommand(db, {
      createdByAccountId: session.accountId,
      frameId: frame.id,
      ttlMs: fetchCommandTtlMs,
      type: "image_get",
    });
  }
  const canWaitForFresh = frame.status === "active";
  if (cached && !(wantsFresh && needsFetch && canWaitForFresh)) {
    return imageResponse(cached);
  }
  if (frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }

  // Long-poll for the image_get result: the first image ever, or one newer
  // than the stale row an explicit refresh is trying to replace.
  const previousUpdatedAt = cached?.updatedAt.getTime() ?? 0;
  const deadline = now + longPollTotalMs;
  while (Date.now() < deadline) {
    await sleep(longPollStepMs);
    const row = await cachedImage(db, frame.id);
    if (row && row.updatedAt.getTime() > previousUpdatedAt) {
      return imageResponse(row);
    }
    const [refused] = await db
      .select({ error: frameCommands.error })
      .from(frameCommands)
      .where(
        and(
          eq(frameCommands.frameId, frame.id),
          eq(frameCommands.type, "image_get"),
          eq(frameCommands.status, "failed"),
          gt(frameCommands.createdAt, new Date(now - 60_000)),
        ),
      )
      .limit(1);
    if (refused) {
      // The device could not serve a fresh image right now (busy mid-render,
      // rebooting, nothing rendered yet). For a refresh of an existing image
      // the stale copy beats an error page.
      if (cached) {
        return imageResponse(cached);
      }
      return jsonError(refused.error ?? "image_unavailable", 404);
    }
  }
  if (cached) {
    return imageResponse(cached);
  }
  return jsonError("image_unavailable", 504);
}
