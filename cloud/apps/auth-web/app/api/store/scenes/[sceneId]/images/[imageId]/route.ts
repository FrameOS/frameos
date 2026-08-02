import { and, eq } from "drizzle-orm";
import { storeSceneImages, storeScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  canAccessPrivateScene,
  shareTokenGrantsAccess,
} from "../../../../../../../src/lib/store-auth";
import {
  jsonError,
  requireDatabase,
} from "../../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string; imageId: string }> };

// An owner-uploaded gallery image; same visibility rules and fixed content
// type as the primary preview image route.
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

  const { imageId, sceneId } = await context.params;
  if (
    !/^[0-9a-f-]{36}$/i.test(sceneId) ||
    !/^[0-9a-f-]{36}$/i.test(imageId)
  ) {
    return jsonError("image_not_found", 404);
  }

  const [row] = await db
    .select({
      accountId: storeScenes.accountId,
      content: storeSceneImages.content,
      contentType: storeSceneImages.contentType,
      shareToken: storeScenes.shareToken,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(storeSceneImages)
    .innerJoin(storeScenes, eq(storeScenes.id, storeSceneImages.sceneId))
    .where(
      and(
        eq(storeSceneImages.id, imageId),
        eq(storeSceneImages.sceneId, sceneId),
      ),
    )
    .limit(1);

  if (!row) {
    return jsonError("image_not_found", 404);
  }
  if (row.status === "pulled") {
    return jsonError("scene_pulled", 410);
  }
  if (row.visibility !== "public") {
    const shared = shareTokenGrantsAccess(
      row.shareToken,
      request.nextUrl.searchParams.get("share"),
    );
    if (
      !shared &&
      !(await canAccessPrivateScene(
        db,
        request.headers.get("authorization"),
        row.accountId,
      ))
    ) {
      return jsonError("image_not_found", 404);
    }
  }

  return new NextResponse(Buffer.from(row.content), {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-length": String(row.content.length),
      "content-type": row.contentType,
      "x-content-type-options": "nosniff",
    },
  });
}
