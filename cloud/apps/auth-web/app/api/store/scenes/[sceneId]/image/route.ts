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
      latestVersion: storeScenes.latestVersion,
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

  // The preview bytes change only when a new version is published, so a
  // request that names the current version (?v=…, emitted by the store
  // repository index) is immutable and can live on the CDN edge for good —
  // a new publish changes the URL. Everything else still gets a day at the
  // edge plus an ETag, so the recurring cost of the Postgres bytea read is
  // one 304 per browser instead of the full image per pageview. Private
  // scenes must never be publicly cached: their URL is guessable and the
  // edge would happily serve the cached copy to anonymous requests.
  const isPublic = scene.visibility === "public";
  const versionParam = request.nextUrl.searchParams.get("v");
  const versionPinned =
    versionParam !== null && versionParam === String(scene.latestVersion);
  const etag = `W/"${sceneId}-${scene.latestVersion}"`;
  const cacheControl = !isPublic
    ? "private, max-age=3600"
    : versionPinned
      ? "public, max-age=86400, s-maxage=31536000, immutable"
      : "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { "cache-control": cacheControl, etag },
    });
  }

  return new NextResponse(Buffer.from(scene.previewImage), {
    headers: {
      "cache-control": cacheControl,
      "content-length": String(scene.previewImage.length),
      "content-type": scene.previewImageType ?? "image/jpeg",
      etag,
      "x-content-type-options": "nosniff",
    },
  });
}
