import { eq } from "drizzle-orm";
import { storeScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { publicBlobUrl, readBlob } from "../../../../../../src/lib/blobs";
import { detectImageContentType } from "../../../../../../src/lib/store";
import {
  canAccessPrivateScene,
  canViewPulledScene,
  shareTokenGrantsAccess,
} from "../../../../../../src/lib/store-auth";
import {
  jsonError,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { storeRoute } from "../../../../../../src/lib/store-cache";
import { imageSetForVersion } from "../../../../../../src/lib/store-images";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// The scene's cover: position 0 of a version's image set — the latest
// version's by default, `?version=N` for a pinned one. Served with a fixed
// image content type, never the uploader's choosing.
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
  if (
    scene.status === "pulled" &&
    !(await canViewPulledScene(scene.accountId))
  ) {
    return jsonError("scene_pulled", 410);
  }
  if (scene.visibility !== "public") {
    const shared = shareTokenGrantsAccess(
      scene.shareToken,
      request.nextUrl.searchParams.get("share"),
    );
    if (
      !shared &&
      !(await canAccessPrivateScene(
        db,
        request.headers.get("authorization"),
        scene.accountId,
      ))
    ) {
      return jsonError("scene_not_found", 404);
    }
  }

  const requested = request.nextUrl.searchParams.get("version");
  const version = requested && /^[0-9]{1,9}$/.test(requested) ? Number(requested) : null;
  const [cover] = await imageSetForVersion(db, sceneId, version);
  if (!cover) {
    return jsonError("scene_not_found", 404);
  }

  // A version's cover never changes, so a request that names the current
  // version (?v=…, emitted by the store repository index) is immutable and
  // can live on the CDN edge for good — a new publish changes the URL.
  // Everything else still gets a day at the edge plus an ETag keyed on the
  // version. Private scenes must never be publicly cached: their URL is
  // guessable and the edge would happily serve the copy to anyone.
  const isPublic = scene.visibility === "public";
  const versionParam = request.nextUrl.searchParams.get("v");
  const versionPinned =
    version !== null ||
    (versionParam !== null && versionParam === String(scene.latestVersion));
  const etag = `W/"${sceneId}-${version ?? scene.latestVersion}-${cover.sha256.slice(0, 12)}"`;
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

  // A public scene's cover is public by construction, so hand the browser
  // the CDN URL and let the edge serve the bytes. Private scenes (and any
  // deployment without a public alias — every dev machine) are proxied
  // here, where the authorization above still applies.
  const cdnUrl = isPublic ? publicBlobUrl(cover.objectKey) : undefined;
  if (cdnUrl) {
    return NextResponse.redirect(cdnUrl, {
      headers: { "cache-control": cacheControl, etag },
      status: 307,
    });
  }

  const bytes = await readBlob(cover);
  if (!bytes) {
    return jsonError("scene_not_found", 404);
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "cache-control": cacheControl,
      "content-length": String(bytes.length),
      // Sniffed, not stored: the bytes cannot be wrong about themselves.
      "content-type": detectImageContentType(bytes) ?? cover.contentType,
      etag,
      "x-content-type-options": "nosniff",
    },
  });
}

// Cache policy is per-response here (see storeRoute): anything this
// handler did not decide is no-store.
export const GET = storeRoute(handleGet);
