import { eq } from "drizzle-orm";
import { storeScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  canAccessPrivateScene,
  shareTokenGrantsAccess,
} from "../../../../../../src/lib/store-auth";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// The preview image extracted from the published zip at publish time; served
// with a fixed image content type, never the uploader's choosing.
export async function GET(request: NextRequest, context: RouteContext) {
  const limited = await rateLimitResponse(request, "store:image", {
    limit: 1200,
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

  const [scene] = await db
    .select({
      accountId: storeScenes.accountId,
      previewImage: storeScenes.previewImage,
      previewImageType: storeScenes.previewImageType,
      shareToken: storeScenes.shareToken,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId))
    .limit(1);

  if (!scene || !scene.previewImage) {
    return jsonError("scene_not_found", 404);
  }
  if (scene.status === "pulled") {
    return jsonError("scene_pulled", 410);
  }
  if (scene.visibility !== "public") {
    const shared = shareTokenGrantsAccess(
      scene.shareToken,
      request.nextUrl.searchParams.get("share"),
    );
    if (
      !shared &&
      !(await canAccessPrivateScene(db, request.headers.get("authorization"), scene.accountId))
    ) {
      return jsonError("scene_not_found", 404);
    }
  }

  return new NextResponse(Buffer.from(scene.previewImage), {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-length": String(scene.previewImage.length),
      "content-type": scene.previewImageType ?? "image/jpeg",
      "x-content-type-options": "nosniff",
    },
  });
}
