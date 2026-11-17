import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { frameAssets, frameCommands } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { directChildren } from "../../../../../src/lib/frame-asset-cache";
import {
  assetStoragePayload,
  commandAssetStorageIs,
  frameAssetStorages,
  resolveAssetStorage,
} from "../../../../../src/lib/frame-asset-storages";
import {
  enqueueFrameCommand,
  frameForAccount,
  supersedePendingCommands,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { sessionMayQueueDeviceCommands } from "../../../../../src/lib/device-command-access";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// An assets_list the frame has not answered in this long is dead weight — the
// next visit to the panel enqueues a fresh one. Long enough for a sleeping
// battery frame that wakes on its render interval to still catch it? No: a
// deep-sleeping frame is exactly the case where the user should see "no
// listing yet" rather than a spinner that lies for an hour.
const listCommandTtlMs = 2 * 60 * 1000;

// A live assets_list of THIS storage: one of the other storage is a
// different question, and must neither block this one nor make it look
// like it is being answered.
async function outstandingListing(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  frameId: string,
  storage: string,
) {
  const [row] = await db
    .select({ id: frameCommands.id })
    .from(frameCommands)
    .where(
      and(
        eq(frameCommands.frameId, frameId),
        eq(frameCommands.type, "assets_list"),
        commandAssetStorageIs(storage),
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
// assetsLogic speaks against the backend: {"assets": […], "storages":
// [{id, name}…], "storage": "…", "cache"?: {"refreshing": true,
// "retry_after": N}}. `?storage=` picks which of the device's storages
// (docs/cloud-frames.md "Asset storages"; the assets folder when absent);
// `storages` is what the frame's newest listing said it has (the assets
// folder alone when it never said). The listing is the hub's cached copy of
// the device's last `assets` reply for that storage (paths relative to it);
// when it is missing or a refresh is asked for, an `assets_list` command is
// queued and the cache marker tells the panel to poll again shortly.
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

  const resolved = await resolveAssetStorage(
    db,
    frame.id,
    request.nextUrl.searchParams.get("storage"),
  );
  if (!resolved.ok) {
    return jsonError(resolved.error, resolved.status);
  }
  const storage = resolved.storage;

  const [listing] = await db
    .select()
    .from(frameAssets)
    .where(and(eq(frameAssets.frameId, frame.id), eq(frameAssets.storage, storage)))
    .limit(1);
  const wantRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  const outstanding = await outstandingListing(db, frame.id, storage);
  let enqueued = false;
  // Only ask a frame that is actually on the hub. A disconnected frame used
  // to make this an infinite loop: every poll re-enqueued assets_list (the
  // previous one kept expiring unanswered), every response said
  // `refreshing`, and the panel refetched every 2 s until the tab closed.
  if (
    !outstanding &&
    frame.status === "active" &&
    frame.connected &&
    (wantRefresh || !listing) &&
    // A read-only token sees the stored listing and never asks for a new
    // one (sessionMayQueueDeviceCommands).
    sessionMayQueueDeviceCommands(session)
  ) {
    // Supersede rather than stack: expired-but-unswept rows of the same type
    // would otherwise pile up under a poller.
    await supersedePendingCommands(db, frame.id, "assets_list", commandAssetStorageIs(storage));
    const storageField = assetStoragePayload(storage);
    await enqueueFrameCommand(db, {
      createdByAccountId: session.accountId,
      frameId: frame.id,
      ...(storageField.storage ? { payload: storageField } : {}),
      ttlMs: listCommandTtlMs,
      type: "assets_list",
    });
    enqueued = true;
  }
  // A pending command on a disconnected frame is not "refreshing" — nothing
  // will answer until the frame redials, so the panel must not poll for it.
  const refreshing = frame.connected && (enqueued || Boolean(outstanding));
  // The panel loads a folder at a time (`folder=`, "" for the root). The hub
  // holds the device's whole listing in one row, so the folder is cut out
  // of that; the echoed `folder` key is how the panel tells this answer from
  // an older server's full listing.
  const folder = request.nextUrl.searchParams.get("folder");
  const payload = Array.isArray(listing?.payload) ? listing.payload : [];
  return NextResponse.json({
    assets: folder === null ? payload : directChildren(payload, folder),
    storage,
    storages: await frameAssetStorages(db, frame.id),
    ...(folder === null ? {} : { folder }),
    ...(listing?.truncated ? { truncated: true } : {}),
    ...(refreshing ? { cache: { refreshing: true, retry_after: 2 } } : {}),
  });
}
