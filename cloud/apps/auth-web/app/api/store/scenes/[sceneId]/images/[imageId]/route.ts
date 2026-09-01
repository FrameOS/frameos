import { and, eq, exists, sql } from "drizzle-orm";
import {
  storeImages,
  storeSceneImages,
  storeSceneVersionImages,
  storeSceneVersions,
  storeScenes,
} from "@frameos-cloud/db";
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
import { sha256Pattern } from "../../../../../../../src/lib/store-images";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string; imageId: string }> };

// One of a scene's images by its digest, provided some version of the scene
// links it; same visibility rules and fixed content type as the cover route.
// The scene's owner also reads digests no version links yet: an upload is
// registered before Save binds it, and the editor shows the thumbnail right
// away. A legacy gallery row id (uuid) is still honoured for links minted
// before images were content-addressed.
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
  if (!/^[0-9a-f-]{36}$/i.test(sceneId)) {
    return jsonError("image_not_found", 404);
  }

  const [scene] = await db
    .select({
      accountId: storeScenes.accountId,
      shareToken: storeScenes.shareToken,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId))
    .limit(1);
  if (!scene) {
    return jsonError("image_not_found", 404);
  }

  let image: { content?: Buffer | null; contentType: string; objectKey: string | null } | undefined;
  let unbound = false;
  if (sha256Pattern.test(imageId)) {
    const [row] = await db
      .select({ contentType: storeImages.contentType, objectKey: storeImages.objectKey })
      .from(storeImages)
      .where(
        and(
          eq(storeImages.sha256, imageId),
          exists(
            db
              .select({ one: sql`1` })
              .from(storeSceneVersionImages)
              .innerJoin(
                storeSceneVersions,
                eq(storeSceneVersions.id, storeSceneVersionImages.versionId),
              )
              .where(
                and(
                  eq(storeSceneVersionImages.imageSha256, storeImages.sha256),
                  eq(storeSceneVersions.sceneId, sceneId),
                ),
              ),
          ),
        ),
      )
      .limit(1);
    image = row;
    // The binding requirement is the public capability boundary — without it
    // any public scene URL could serve any registered digest. The owner's
    // draft sits on the other side of it: uploaded, not yet published by
    // Save, and theirs to see.
    if (
      !image &&
      (await canAccessPrivateScene(
        db,
        request.headers.get("authorization"),
        scene.accountId,
      ))
    ) {
      const [draft] = await db
        .select({ contentType: storeImages.contentType, objectKey: storeImages.objectKey })
        .from(storeImages)
        .where(eq(storeImages.sha256, imageId))
        .limit(1);
      image = draft;
      unbound = draft !== undefined;
    }
  } else if (/^[0-9a-f-]{36}$/i.test(imageId)) {
    const [row] = await db
      .select({
        content: storeSceneImages.content,
        contentType: storeSceneImages.contentType,
        objectKey: storeSceneImages.objectKey,
      })
      .from(storeSceneImages)
      .where(and(eq(storeSceneImages.id, imageId), eq(storeSceneImages.sceneId, sceneId)))
      .limit(1);
    image = row;
  }
  if (!image) {
    return jsonError("image_not_found", 404);
  }
  if (scene.status === "pulled" && !(await canViewPulledScene(scene.accountId))) {
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
      return jsonError("image_not_found", 404);
    }
  }

  // The digest is the URL, so the bytes behind it never change. An unbound
  // draft image is an owner-only read whatever the scene's visibility, so it
  // must never sit at the edge or hand out the public CDN capability.
  const cacheControl =
    scene.visibility === "public" && !unbound
      ? "public, max-age=86400, s-maxage=31536000, immutable"
      : "private, max-age=3600";
  const cdnUrl =
    scene.visibility === "public" && !unbound
      ? publicBlobUrl(image.objectKey)
      : undefined;
  if (cdnUrl) {
    return NextResponse.redirect(cdnUrl, {
      headers: { "cache-control": cacheControl },
      status: 307,
    });
  }

  const content = await readBlob(image);
  if (!content) {
    return jsonError("image_not_found", 404);
  }

  return new NextResponse(new Uint8Array(content), {
    headers: {
      "cache-control": cacheControl,
      "content-length": String(content.length),
      // The stored content_type is only as good as whatever wrote it; the
      // bytes are authoritative.
      "content-type": detectImageContentType(content) ?? image.contentType,
      "x-content-type-options": "nosniff",
    },
  });
}

// Cache policy is per-response here (see storeRoute): anything this
// handler did not decide is no-store.
export const GET = storeRoute(handleGet);
