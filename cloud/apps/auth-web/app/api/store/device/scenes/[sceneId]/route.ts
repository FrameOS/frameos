import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { storeRoute } from "../../../../../../src/lib/store-cache";
import { storeSceneForDevice } from "../../../../../../src/lib/store-device";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// One store scene for a frame's own screen (docs/scene-store-on-frame.md): its
// name, shelf, publisher, a short description and its newest version, which
// is what an installed copy's `origin.version` is compared with to offer an
// update. Only scenes the frame's store page lists; anything else is 404.
async function handleGet(request: NextRequest, context: RouteContext) {
  const limited = await rateLimitResponse(request, "store:device", {
    limit: 600,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const { sceneId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(sceneId)) {
    return jsonError("scene_not_found", 404);
  }
  const scene = await storeSceneForDevice(db, sceneId);
  if (!scene) {
    return jsonError("scene_not_found", 404);
  }
  return NextResponse.json(scene, {
    headers: { "cache-control": "public, max-age=60" },
  });
}

export const GET = storeRoute(handleGet);
