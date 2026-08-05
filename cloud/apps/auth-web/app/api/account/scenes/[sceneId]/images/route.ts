import { eq, sql } from "drizzle-orm";
import { storeSceneImages } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { decodeBackupContent } from "../../../../../../src/lib/backups";
import { jsonError, readJsonObject } from "../../../../../../src/lib/device-flow";
import { moderateStoreContent } from "../../../../../../src/lib/moderation";
import {
  detectImageContentType,
  maxImagesPerScene,
  maxPreviewImageBytes,
  maxSceneZipBytes,
} from "../../../../../../src/lib/store";
import { syncLatestSceneZipPreview } from "../../../../../../src/lib/store-image-sync";
import { loadOwnedScene } from "../../../../../../src/lib/store-owner";
import {
  maxPrivateSceneBytesPerAccount,
  privateSceneBytesForAccount,
} from "../../../../../../src/lib/usage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// Owner upload of an additional gallery image for a store scene. The bytes
// are sniffed for a real image signature (they are served back with a fixed
// content type) and pass the same moderation gate as the publish-time
// preview image.
export async function POST(request: NextRequest, context: RouteContext) {
  const { db, errorResponse, scene, session } = await loadOwnedScene(
    request,
    context,
  );
  if (!scene || !db || !session) {
    return errorResponse;
  }
  if (scene.status === "pulled") {
    return jsonError("scene_pulled", 403);
  }

  const body = await readJsonObject(request);
  const content = decodeBackupContent(body.content_base64);
  if (!content || content.length === 0) {
    return jsonError("invalid_content", 400);
  }
  if (content.length > maxPreviewImageBytes) {
    return jsonError("image_too_large", 413, {
      max_bytes: maxPreviewImageBytes,
    });
  }

  const contentType = detectImageContentType(content);
  if (!contentType) {
    return jsonError("unsupported_image", 400);
  }

  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storeSceneImages)
    .where(eq(storeSceneImages.sceneId, scene.id));
  if ((counted?.count ?? 0) >= maxImagesPerScene) {
    return jsonError("image_quota_exceeded", 403, {
      max_images: maxImagesPerScene,
    });
  }
  // Gallery bytes count into the private-scene quota (they always did in the
  // usage display; this write path just never checked). Public scenes are
  // free (usage.ts).
  if (scene.visibility !== "public") {
    const privateBytes = await privateSceneBytesForAccount(db, session.accountId!);
    if (privateBytes + content.length > maxPrivateSceneBytesPerAccount) {
      return jsonError("storage_quota_exceeded", 403, {
        max_bytes: maxPrivateSceneBytesPerAccount,
        private_bytes: Math.round(privateBytes),
      });
    }
  }

  const moderation = await moderateStoreContent({
    image: { content, contentType },
    texts: [],
  });
  if (!moderation.ok) {
    if (moderation.error === "content_rejected") {
      await recordAuditEvent(db, {
        accountId: session.accountId,
        actor: {
          accountId: session.accountId,
          providerSubject: session.providerSubject,
        },
        eventType: "store.image_rejected",
        metadata: { categories: moderation.categories },
        target: { sceneId: scene.id },
      });
      return jsonError("content_rejected", 422, {
        categories: moderation.categories,
      });
    }
    return jsonError("moderation_unavailable", 503);
  }

  const [maxPosition] = await db
    .select({
      position: sql<number>`coalesce(max(${storeSceneImages.position}), 0)::int`,
    })
    .from(storeSceneImages)
    .where(eq(storeSceneImages.sceneId, scene.id));

  const [created] = await db
    .insert(storeSceneImages)
    .values({
      content,
      contentType,
      position: (maxPosition?.position ?? 0) + 1,
      sceneId: scene.id,
    })
    .returning({ id: storeSceneImages.id });
  if (!created) {
    return jsonError("image_create_failed", 500);
  }

  // With no publish-time primary image, the first gallery image is the lead
  // preview. Append a version whose ZIP contains it, preserving all older
  // versions exactly as published.
  let version: number | undefined;
  if (!scene.previewImage && (counted?.count ?? 0) === 0) {
    const synced = await syncLatestSceneZipPreview(db, scene, content);
    if (!synced.ok) {
      await db
        .delete(storeSceneImages)
        .where(eq(storeSceneImages.id, created.id));
      return syncError(synced.error);
    }
    version = synced.version;
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "store.image_added",
    metadata: { imageId: created.id, sizeBytes: content.length, version },
    target: { sceneId: scene.id },
  });

  return NextResponse.json({
    image: { id: created.id },
    status: "added",
    ...(version ? { version } : {}),
  });
}

function syncError(error: string) {
  if (error === "version_not_found") {
    return jsonError(error, 404);
  }
  if (error === "scene_too_large") {
    return jsonError(error, 413, { max_bytes: maxSceneZipBytes });
  }
  return jsonError(error, 500);
}
