import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { frameAssets, frameCommands } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import {
  enqueueFrameCommand,
  frameForAccount,
  supersedePendingCommands,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// An assets_list the frame has not answered in this long is dead weight — the
// next visit to the panel enqueues a fresh one. Long enough for a sleeping
// battery frame that wakes on its render interval to still catch it? No: a
// deep-sleeping frame is exactly the case where the user should see "no
// listing yet" rather than a spinner that lies for an hour.
const listCommandTtlMs = 2 * 60 * 1000;

async function outstandingCommand(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  frameId: string,
  type: string,
) {
  const [row] = await db
    .select({ id: frameCommands.id })
    .from(frameCommands)
    .where(
      and(
        eq(frameCommands.frameId, frameId),
        eq(frameCommands.type, type),
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

// The per-frame assets listing, in the exact shape the shared SPA's
// assetsLogic speaks against the backend: {"assets": […], "cache"?:
// {"refreshing": true, "retry_after": N}}. The listing is the hub's cached
// copy of the device's last `assets` reply (paths relative to the device's
// assets directory); when it is missing or a refresh is asked for, an
// `assets_list` command is queued and the cache marker tells the panel to
// poll again shortly.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:assets", {
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

  const [listing] = await db
    .select()
    .from(frameAssets)
    .where(eq(frameAssets.frameId, frame.id))
    .limit(1);
  const wantRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  const outstanding = await outstandingCommand(db, frame.id, "assets_list");
  let enqueued = false;
  if (
    !outstanding &&
    frame.status === "active" &&
    (wantRefresh || !listing)
  ) {
    // Supersede rather than stack: expired-but-unswept rows of the same type
    // would otherwise pile up under a poller.
    await supersedePendingCommands(db, frame.id, "assets_list");
    await enqueueFrameCommand(db, {
      createdByAccountId: session.accountId,
      frameId: frame.id,
      ttlMs: listCommandTtlMs,
      type: "assets_list",
    });
    enqueued = true;
  }
  const refreshing = enqueued || Boolean(outstanding);
  return NextResponse.json({
    assets: listing?.payload ?? [],
    ...(listing?.truncated ? { truncated: true } : {}),
    ...(refreshing ? { cache: { refreshing: true, retry_after: 2 } } : {}),
  });
}
