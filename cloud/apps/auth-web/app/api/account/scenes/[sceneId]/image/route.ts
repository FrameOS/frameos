import { asc, eq } from "drizzle-orm";
import { storeSceneImages, storeScenes } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../../../src/lib/device-flow";
import { maxSceneZipBytes } from "../../../../../../src/lib/store";
import { syncLatestSceneZipPreview } from "../../../../../../src/lib/store-image-sync";
import { loadOwnedScene } from "../../../../../../src/lib/store-owner";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// Owner removal of the primary storefront preview. The prior ZIP version stays
// immutable; a new latest version uses the first gallery image, or no image.
export async function DELETE(request: NextRequest, context: RouteContext) {
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
  if (!scene.previewImage) {
    return jsonError("image_not_found", 404);
  }

  const [galleryLead] = await db
    .select({ content: storeSceneImages.content })
    .from(storeSceneImages)
    .where(eq(storeSceneImages.sceneId, scene.id))
    .orderBy(
      asc(storeSceneImages.position),
      asc(storeSceneImages.createdAt),
    )
    .limit(1);
  const synced = await syncLatestSceneZipPreview(
    db,
    scene,
    galleryLead ? Buffer.from(galleryLead.content) : undefined,
  );
  if (!synced.ok) {
    return syncError(synced.error);
  }

  await db
    .update(storeScenes)
    .set({
      previewImage: null,
      previewImageHeight: null,
      previewImageType: null,
      previewImageWidth: null,
      updatedAt: new Date(),
    })
    .where(eq(storeScenes.id, scene.id));

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "store.image_removed",
    metadata: {
      kind: "primary preview",
      name: scene.name,
      version: synced.version,
    },
    target: { sceneId: scene.id },
  });

  return NextResponse.json({ status: "removed", version: synced.version });
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
