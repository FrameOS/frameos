import { asc, eq } from "drizzle-orm";
import { storeSceneImages, storeScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { publicBlobUrl, readBlob } from "../../../../../../src/lib/blobs";
import { detectImageContentType } from "../../../../../../src/lib/store";
import {
  canAccessPrivateScene,
  shareTokenGrantsAccess,
} from "../../../../../../src/lib/store-auth";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { storeRoute } from "../../../../../../src/lib/store-cache";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// The preview image extracted from the published zip at publish time, or —
// when the owner removed that and only gallery screenshots remain — the
// first gallery image. Served with a fixed image content type, never the
// uploader's choosing.
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
      previewObjectKey: storeScenes.previewObjectKey,
      shareToken: storeScenes.shareToken,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId))
    .limit(1);

  if (!scene) {
    return jsonError("scene_not_found", 404);
  }
  let preview: {
    content: Buffer | null;
    objectKey: string | null;
    tag: string;
  } = {
    content: scene.previewImage,
    objectKey: scene.previewObjectKey,
    tag: String(scene.latestVersion),
  };
  if (!scene.previewImage && !scene.previewObjectKey) {
    const [lead] = await db
      .select({
        content: storeSceneImages.content,
        id: storeSceneImages.id,
        objectKey: storeSceneImages.objectKey,
      })
      .from(storeSceneImages)
      .where(eq(storeSceneImages.sceneId, sceneId))
      .orderBy(asc(storeSceneImages.position), asc(storeSceneImages.createdAt))
      .limit(1);
    if (!lead) {
      return jsonError("scene_not_found", 404);
    }
    preview = { content: lead.content, objectKey: lead.objectKey, tag: lead.id };
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
  // A gallery lead is keyed by its row id: adding/removing images changes
  // which one leads, while latestVersion may not move.
  const etag = `W/"${sceneId}-${preview.tag}"`;
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

  // A public scene's preview is public by construction, so hand the browser
  // the CDN URL and let the edge serve the bytes. Private scenes (and any
  // deployment without a public alias — every dev machine) are proxied here,
  // where the authorization above still applies.
  const cdnUrl = isPublic ? publicBlobUrl(preview.objectKey) : undefined;
  if (cdnUrl) {
    return NextResponse.redirect(cdnUrl, {
      headers: { "cache-control": cacheControl, etag },
      status: 307,
    });
  }

  const bytes = await readBlob({
    content: preview.content,
    objectKey: preview.objectKey,
  });
  if (!bytes) {
    return jsonError("scene_not_found", 404);
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "cache-control": cacheControl,
      "content-length": String(bytes.length),
      // Sniffed, not stored. previewImageType is only as good as whatever
      // wrote it, and rows published before the type was sniffed at all say
      // "image/jpeg" over PNG bytes. The bytes cannot be wrong about
      // themselves.
      "content-type":
        detectImageContentType(bytes) ?? scene.previewImageType ?? "image/jpeg",
      etag,
      "x-content-type-options": "nosniff",
    },
  });
}

// Cache policy is per-response here (see storeRoute): anything this
// handler did not decide is no-store.
export const GET = storeRoute(handleGet);
