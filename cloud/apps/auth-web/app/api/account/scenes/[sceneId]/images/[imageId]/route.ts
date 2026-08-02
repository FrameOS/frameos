import { and, asc, eq, ne } from "drizzle-orm";
import { storeSceneImages } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../../../../src/lib/device-flow";
import { maxSceneZipBytes } from "../../../../../../../src/lib/store";
import { syncLatestSceneZipPreview } from "../../../../../../../src/lib/store-image-sync";
import { loadOwnedScene } from "../../../../../../../src/lib/store-owner";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string; imageId: string }> };

// Owner removal of a gallery image.
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

  const { imageId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(imageId)) {
    return jsonError("image_not_found", 404);
  }

  const [target] = await db
    .select({ id: storeSceneImages.id })
    .from(storeSceneImages)
    .where(
      and(
        eq(storeSceneImages.id, imageId),
        eq(storeSceneImages.sceneId, scene.id),
      ),
    )
    .limit(1);
  if (!target) {
    return jsonError("image_not_found", 404);
  }

  let version: number | undefined;
  if (!scene.previewImage) {
    const [lead] = await db
      .select({ id: storeSceneImages.id })
      .from(storeSceneImages)
      .where(eq(storeSceneImages.sceneId, scene.id))
      .orderBy(
        asc(storeSceneImages.position),
        asc(storeSceneImages.createdAt),
      )
      .limit(1);
    if (lead?.id === imageId) {
      const [nextLead] = await db
        .select({ content: storeSceneImages.content })
        .from(storeSceneImages)
        .where(
          and(
            eq(storeSceneImages.sceneId, scene.id),
            ne(storeSceneImages.id, imageId),
          ),
        )
        .orderBy(
          asc(storeSceneImages.position),
          asc(storeSceneImages.createdAt),
        )
        .limit(1);
      const synced = await syncLatestSceneZipPreview(
        db,
        scene,
        nextLead ? Buffer.from(nextLead.content) : undefined,
      );
      if (!synced.ok) {
        return syncError(synced.error);
      }
      version = synced.version;
    }
  }

  const [deleted] = await db
    .delete(storeSceneImages)
    .where(
      and(
        eq(storeSceneImages.id, imageId),
        eq(storeSceneImages.sceneId, scene.id),
      ),
    )
    .returning({ id: storeSceneImages.id });
  if (!deleted) {
    return jsonError("image_not_found", 404);
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "store.image_removed",
    metadata: { imageId, version },
    target: { sceneId: scene.id },
  });

  return NextResponse.json({
    status: "removed",
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
