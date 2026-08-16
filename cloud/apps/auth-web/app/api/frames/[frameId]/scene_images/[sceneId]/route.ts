import { NextRequest, NextResponse } from "next/server";
import { readBlob } from "../../../../../../src/lib/blobs";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import {
  cachedAssetFile,
  queueAssetGetIfIdle,
  recentFailedAssetGet,
  sceneSnapshotAssetPath,
} from "../../../../../../src/lib/frame-asset-cache";
import { frameForAccount } from "../../../../../../src/lib/frames";
import {
  resolveStoreSceneForFrameScene,
  storeSceneCoverImage,
} from "../../../../../../src/lib/scene-images";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";

export const runtime = "nodejs";

// Scene tiles re-render often; a snapshot this old is re-requested in the
// background while the stale bytes still serve. Shorter than the generic
// asset route's 15 min — a deploy changes what a scene renders.
const snapshotStaleAfterMs = 5 * 60 * 1000;
// A device that just said not_found (scene never rendered, ESP32 with no
// snapshot store) is not asked again for this long — tiles poll, and every
// poll re-queueing a doomed command would keep the frame busy for nothing.
const refusalMemoryMs = 5 * 60 * 1000;
// Only reached when there is no store cover to serve meanwhile: bounded by
// what an <img> tolerates, and short enough not to pile up connections when
// a frame is asleep.
const longPollTotalMs = 10_000;
const longPollStepMs = 750;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function imageResponse(content: Buffer, contentType: string, maxAge: number) {
  return new NextResponse(new Uint8Array(content), {
    headers: {
      // Private: these bytes describe one user's frame. Held briefly so a
      // re-render does not re-download every tile; the SPA busts with ?t=.
      "cache-control": `private, max-age=${maxAge}`,
      "content-length": String(content.length),
      "content-type": contentType || "image/png",
      "x-content-type-options": "nosniff",
    },
  });
}

// Device snapshots change on every deploy and scene switch; store covers only
// on republish.
const snapshotBrowserMaxAge = 60;
const coverBrowserMaxAge = 300;

// Per-scene preview — the exact route the shared SPA's scene tiles already
// call (cloud/docs/cloud-workspace-gaps.md item 2). Priority order:
//
//   1. The device's own snapshot: the runner writes a per-scene PNG under
//      {assets}/.frameos/scene_images/ on first render and every scene
//      switch, and the existing asset_get verb can stream it — the hub
//      caches it in frame_asset_files like any other asset. ?thumb=1 rides
//      the device's 320x320 thumbnail path, so tiles stay small.
//   2. The cover image of the store scene an assignment installed (the
//      short-term serve that used to be the whole implementation). The SPA
//      passes the RUNTIME scene id, so scene-images.ts maps it back to the
//      owning store scene; the raw store uuid works too.
//   3. When neither exists yet, a brief long-poll for the queued device
//      fetch, then an honest 404.
//
// Owning the frame is the authorization — its scenes' renders and covers
// are, by construction, content the account put there.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string; sceneId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:scene_image", {
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
  const { frameId, sceneId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }

  const thumb = request.nextUrl.searchParams.get("thumb") === "1";
  const snapshotPath = sceneSnapshotAssetPath(sceneId);

  const cached = await cachedAssetFile(db, frame.id, snapshotPath, thumb);
  const now = Date.now();
  const needsFetch =
    !cached || now - cached.updatedAt.getTime() > snapshotStaleAfterMs;
  let refused = needsFetch
    ? await recentFailedAssetGet(
        db,
        frame.id,
        snapshotPath,
        thumb,
        refusalMemoryMs,
      )
    : undefined;
  if (needsFetch && !refused && frame.status === "active") {
    await queueAssetGetIfIdle(
      db,
      session.accountId,
      frame.id,
      snapshotPath,
      thumb,
    );
  }
  const cachedContent = await readBlob(cached);
  if (cachedContent) {
    // Stale-while-revalidate: the refresh (if any) was queued above.
    return imageResponse(cachedContent, cached!.contentType, snapshotBrowserMaxAge);
  }

  const cover = await storeSceneCover(db, frame.id, sceneId);
  if (cover) {
    return imageResponse(cover.content, cover.contentType, coverBrowserMaxAge);
  }

  // Long-polling only makes sense for a frame that is on the socket right
  // now; a sleeping frame still gets the queued fetch on its next sync, and
  // the tile heals on a later request.
  if (refused || frame.status !== "active" || !frame.connected) {
    return jsonError("no_image", 404);
  }
  const deadline = now + longPollTotalMs;
  while (Date.now() < deadline) {
    await sleep(longPollStepMs);
    const row = await cachedAssetFile(db, frame.id, snapshotPath, thumb);
    const rowContent = await readBlob(row);
    if (rowContent) {
      return imageResponse(rowContent, row!.contentType, snapshotBrowserMaxAge);
    }
    refused = await recentFailedAssetGet(
      db,
      frame.id,
      snapshotPath,
      thumb,
      60_000,
    );
    if (refused) {
      return jsonError("no_image", 404);
    }
  }
  return jsonError("no_image", 404);
}

type Db = NonNullable<ReturnType<typeof requireDatabase>["db"]>;

async function storeSceneCover(db: Db, frameId: string, sceneId: string) {
  const storeSceneId = await resolveStoreSceneForFrameScene(
    db,
    frameId,
    sceneId,
  );
  if (!storeSceneId) {
    return undefined;
  }
  return await storeSceneCoverImage(db, storeSceneId);
}
