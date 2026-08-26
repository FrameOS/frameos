import { and, eq } from "drizzle-orm";
import { storeSceneImages, storeScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { publicBlobUrl, readBlob } from "../../../../../../../src/lib/blobs";
import { detectImageContentType } from "../../../../../../../src/lib/store";
import {
  canAccessPrivateScene,
  canViewPulledScene,
  shareTokenGrantsAccess,
} from "../../../../../../../src/lib/store-auth";
import {
  jsonError,
  requireDatabase,
} from "../../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../../src/lib/rate-limit";
import { storeRoute } from "../../../../../../../src/lib/store-cache";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string; imageId: string }> };

// An owner-uploaded gallery image; same visibility rules and fixed content
// type as the primary preview image route.
async function handleGet(request: NextRequest, context: RouteContext) {
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
  if (!/^[0-9a-f-]{36}$/i.test(sceneId) || !/^[0-9a-f-]{36}$/i.test(imageId)) {
    return jsonError("image_not_found", 404);
  }

  const [row] = await db
    .select({
      accountId: storeScenes.accountId,
      content: storeSceneImages.content,
      contentType: storeSceneImages.contentType,
      objectKey: storeSceneImages.objectKey,
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
  if (row.status === "pulled" && !(await canViewPulledScene(row.accountId))) {
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

  const cdnUrl =
    row.visibility === "public" ? publicBlobUrl(row.objectKey) : undefined;
  if (cdnUrl) {
    return NextResponse.redirect(cdnUrl, {
      headers: { "cache-control": "public, max-age=3600" },
      status: 307,
    });
  }

  const content = await readBlob(row);
  if (!content) {
    return jsonError("image_not_found", 404);
  }

  return new NextResponse(new Uint8Array(content), {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-length": String(content.length),
      // The stored content_type defaults to image/jpeg and older rows kept
      // that default over PNG bytes; the bytes are authoritative.
      "content-type": detectImageContentType(content) ?? row.contentType,
      "x-content-type-options": "nosniff",
    },
  });
}

// Cache policy is per-response here (see storeRoute): anything this
// handler did not decide is no-store.
export const GET = storeRoute(handleGet);
