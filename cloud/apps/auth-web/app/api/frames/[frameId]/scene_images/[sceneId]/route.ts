import { NextRequest, NextResponse } from "next/server";
import { readBlob } from "../../../../../../src/lib/blobs";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import {
  assetFetchCommandTtlMs,
  cachedAssetFile,
  queueAssetGetIfIdle,
  recentFailedAssetGet,
  sceneSnapshotAssetPath,
} from "../../../../../../src/lib/frame-asset-cache";
import { commandTtlForFrame } from "../../../../../../src/lib/frame-sleep";
import {
  frameForAccount,
  frameHardwareIsEsp32,
  markFramePreviewWatched,
  maxAssetFileBytes,
  storeFrameAssetFile,
} from "../../../../../../src/lib/frames";
import {
  resolveStoreSceneForFrameScene,
  storeSceneCoverImage,
} from "../../../../../../src/lib/scene-images";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";
import { detectImageContentType } from "../../../../../../src/lib/store";

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

  // Someone has this frame's scenes on screen. The device's next "render"
  // announcement is then worth an asset_get; without this stamp the hub
  // ignores it, and previews only refresh when a tile happens to ask
  // (lib/frames.ts, previewWatchWindowMs).
  await markFramePreviewWatched(db, frame.id);

  const thumb = request.nextUrl.searchParams.get("thumb") === "1";
  const snapshotPath = sceneSnapshotAssetPath(sceneId);

  const cached = await cachedAssetFile(db, frame.id, snapshotPath, thumb);
  const now = Date.now();
  const needsFetch =
    !cached || now - cached.updatedAt.getTime() > snapshotStaleAfterMs;
  // A snapshot fetch is only worth queueing toward a device that has
  // snapshot files AND is on the socket right now:
  //
  //   - ESP32 firmware keeps none — its image is its framebuffer, fetched
  //     with image_get by the hub's `render` handler — so every per-scene
  //     asset_get it is sent comes back not_found. Tiles poll, and on a
  //     battery frame that meant one doomed command per scene per wake.
  //   - A frame that is asleep or offline renders nothing: whatever the cache
  //     holds is exactly what is on the card, so a "stale" copy is not stale.
  //     Queueing anyway just parks a fetch per scene in the command queue
  //     until the wake (the deploy drawer lists every one of them), and the
  //     wake that renders re-fetches the active scene through `render`.
  //
  // The install-time cover copy and the store cover keep the tile filled
  // meanwhile; the device's own snapshot replaces them the next time a tile
  // asks while the frame is connected.
  const canFetchSnapshot =
    frame.status === "active" &&
    frame.connected &&
    !frameHardwareIsEsp32(frame);
  let refused =
    needsFetch && canFetchSnapshot
      ? await recentFailedAssetGet(
          db,
          frame.id,
          snapshotPath,
          thumb,
          refusalMemoryMs,
        )
      : undefined;
  if (needsFetch && canFetchSnapshot && !refused) {
    await queueAssetGetIfIdle(
      db,
      session.accountId,
      frame.id,
      snapshotPath,
      thumb,
      commandTtlForFrame(frame, assetFetchCommandTtlMs, now),
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

  // Long-polling only makes sense when a fetch was actually queued toward a
  // device that can answer it now; otherwise the tile heals on a later
  // request.
  if (refused || !canFetchSnapshot) {
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

// Give a scene a cover from bytes the browser already holds — the image.jpg
// of an uploaded template zip, a split-screen render. The same call the
// self-hosted backend and the on-device admin answer, so the shared SPA's
// "Upload scene" needs no cloud branch. The bytes land in the frame's
// snapshot cache under the exact (path, thumb) rows the device's own render
// will later overwrite through the asset_get chunk stream: the tile serves
// them from the next request, and a real snapshot still wins when it
// arrives. Explicit and unconditional, unlike copySceneCoversIntoFrameCache:
// the user chose this image for this scene. The private cloud scene the next
// save creates picks it up from here (preview_from_frame on
// POST /api/account/scenes), so it outlives the cache's LRU pruning.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string; sceneId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:scene_image_write", {
    limit: 120,
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
  if (!sceneId || sceneId.length > 200) {
    return jsonError("invalid_scene", 400);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxAssetFileBytes) {
    return jsonError("image_too_large", 413, { max_bytes: maxAssetFileBytes });
  }
  const content = Buffer.from(await request.arrayBuffer());
  if (content.length === 0) {
    return jsonError("missing_image", 400);
  }
  if (content.length > maxAssetFileBytes) {
    return jsonError("image_too_large", 413, { max_bytes: maxAssetFileBytes });
  }
  // Sniffed, never trusted: the SPA labels a zip's image.jpg by convention,
  // and the tile route serves whatever content type the row says.
  const contentType = detectImageContentType(content);
  if (!contentType) {
    return jsonError("invalid_image", 400);
  }
  const path = sceneSnapshotAssetPath(sceneId);
  // The thumb row gets the full bytes too (as the install-time cover copy
  // does); the device's 320px thumbnail replaces it on the first render.
  for (const thumb of [false, true]) {
    const stored = await storeFrameAssetFile(db, frame.id, {
      content,
      contentType,
      path,
      thumb,
    });
    if (!stored) {
      return jsonError("image_too_large", 413, { max_bytes: maxAssetFileBytes });
    }
  }
  return NextResponse.json(
    { content_type: contentType, scene_id: sceneId, size_bytes: content.length },
    { status: 201 },
  );
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
