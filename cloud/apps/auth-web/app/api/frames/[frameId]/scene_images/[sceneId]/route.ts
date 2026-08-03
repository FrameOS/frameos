import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { frameForAccount } from "../../../../../../src/lib/frames";
import {
  resolveStoreSceneForFrameScene,
  storeSceneCoverImage,
} from "../../../../../../src/lib/scene-images";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";

export const runtime = "nodejs";

// Per-scene preview — the exact route the shared SPA's scene tiles already
// call (cloud/docs/cloud-workspace-gaps.md item 2). Short-term implementation:
// serve the cover image of the store scene the assignment installed. The SPA
// passes the RUNTIME scene id (from the zip's scenes.json, hydrated into the
// tiles), so scene-images.ts maps it back to the owning store scene; the raw
// store uuid works too. Owning the frame is the authorization — its assigned
// scenes' covers are, by construction, content the account installed.
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

  const storeSceneId = await resolveStoreSceneForFrameScene(
    db,
    frame.id,
    sceneId,
  );
  if (!storeSceneId) {
    return jsonError("no_image", 404);
  }
  const image = await storeSceneCoverImage(db, storeSceneId);
  if (!image) {
    return jsonError("no_image", 404);
  }
  return new NextResponse(new Uint8Array(image.content), {
    headers: {
      // Covers change rarely (only on republish/regallery); the frame page
      // may poll tiles, so let the browser hold them briefly — but privately,
      // this sits behind a session.
      "cache-control": "private, max-age=300",
      "content-length": String(image.content.length),
      "content-type": image.contentType,
      "x-content-type-options": "nosniff",
    },
  });
}
