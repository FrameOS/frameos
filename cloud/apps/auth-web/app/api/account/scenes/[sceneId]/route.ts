import { and, desc, eq } from "drizzle-orm";
import {
  storeSceneImages,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { getScenesBaseUrl } from "../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";
import {
  blobNamespaces,
  readBlob,
  storeBlob,
} from "../../../../../src/lib/blobs";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { normalizeCategory } from "../../../../../src/lib/categories";
import { moderateStoreContent } from "../../../../../src/lib/moderation";
import {
  maxSceneZipBytes,
  normalizeFrameosVersion,
  normalizeTags,
  rebuildZipWithFrameosVersion,
  sceneSummary,
  sceneVisibilities,
  validateSceneZip,
} from "../../../../../src/lib/store";
import { loadOwnedScene } from "../../../../../src/lib/store-owner";
import {
  maxPrivateSceneBytesPerAccount,
  privateSceneBytesForAccount,
  sceneBytesTotal,
} from "../../../../../src/lib/usage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// One owned scene with what the /s/[slug] page shows its owner: the
// summary, every version (yanked ones included — yank hides from "latest",
// it does not delete) and the gallery image ids. The content itself stays
// at GET /api/store/scenes/{id}/scenes.json?version=N.
export async function GET(request: NextRequest, context: RouteContext) {
  const limited = await rateLimitResponse(request, "account:scene-detail", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
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
    .select()
    .from(storeScenes)
    .where(
      and(
        eq(storeScenes.id, sceneId),
        eq(storeScenes.accountId, session.accountId),
      ),
    )
    .limit(1);
  if (!scene) {
    return jsonError("scene_not_found", 404);
  }
  const [versions, images] = await Promise.all([
    db
      .select({
        createdAt: storeSceneVersions.createdAt,
        frameosVersion: storeSceneVersions.frameosVersion,
        message: storeSceneVersions.message,
        riskFlags: storeSceneVersions.riskFlags,
        sha256: storeSceneVersions.sha256,
        sizeBytes: storeSceneVersions.sizeBytes,
        version: storeSceneVersions.version,
        yankedAt: storeSceneVersions.yankedAt,
      })
      .from(storeSceneVersions)
      .where(eq(storeSceneVersions.sceneId, scene.id))
      .orderBy(desc(storeSceneVersions.version)),
    db
      .select({
        contentType: storeSceneImages.contentType,
        createdAt: storeSceneImages.createdAt,
        id: storeSceneImages.id,
        position: storeSceneImages.position,
        sizeBytes: storeSceneImages.sizeBytes,
      })
      .from(storeSceneImages)
      .where(eq(storeSceneImages.sceneId, scene.id))
      .orderBy(storeSceneImages.position, storeSceneImages.createdAt),
  ]);
  const hasPrimaryPreview =
    scene.previewImage !== null || scene.previewObjectKey !== null;
  return NextResponse.json(
    {
      images: images.map((image) => ({
        content_type: image.contentType,
        created_at: image.createdAt.toISOString(),
        id: image.id,
        position: image.position,
        size_bytes: image.sizeBytes,
        url: `/api/store/scenes/${scene.id}/images/${image.id}`,
      })),
      scene: {
        ...sceneSummary(scene),
        has_preview: hasPrimaryPreview || images.length > 0,
        preview_url: hasPrimaryPreview
          ? `/api/store/scenes/${scene.id}/image?v=${scene.latestVersion}`
          : (images[0] && `/api/store/scenes/${scene.id}/images/${images[0].id}`) ?? null,
        pulled_reason: scene.pulledReason,
        share_url: scene.shareToken
          ? `${getScenesBaseUrl()}/s/${scene.slug}?share=${scene.shareToken}`
          : null,
        url: `${getScenesBaseUrl()}/s/${scene.slug}`,
      },
      versions: versions.map((version) => ({
        created_at: version.createdAt.toISOString(),
        frameos_version: version.frameosVersion,
        message: version.message,
        risk_flags: version.riskFlags,
        sha256: version.sha256,
        size_bytes: version.sizeBytes,
        version: version.version,
        yanked: version.yankedAt !== null,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// Owner management of a published scene from the web: visibility toggle,
// description/tags/minimum FrameOS version edit, delete. Moderation state
// (status/featured) is admin-only and lives under /api/admin/scenes.

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { db, errorResponse, scene, session } = await loadOwnedScene(
    request,
    context,
  );
  if (!scene || !db || !session) {
    return errorResponse;
  }

  const body = await readJsonObject(request);
  const changes: Partial<{
    category: string | null;
    description: string | null;
    frameosVersion: string | null;
    latestVersion: number;
    tags: string[];
    updatedAt: Date;
    visibility: string;
  }> = {};

  const visibility = parseOptionalString(body.visibility);
  if (visibility !== undefined) {
    if (!sceneVisibilities.has(visibility)) {
      return jsonError("invalid_visibility", 400);
    }
    // A pulled scene stays hidden regardless; flipping visibility on it is
    // confusing at best, so reject it outright.
    if (scene.status === "pulled") {
      return jsonError("scene_pulled", 403);
    }
    // Public scenes are quota-free, so making one private moves its bytes
    // back onto the meter — refuse the flip when it would land the account
    // over quota instead of letting the toggle dodge every other check.
    if (visibility === "private" && scene.visibility === "public") {
      const [privateBytes, flippedBytes] = await Promise.all([
        privateSceneBytesForAccount(db, session.accountId!),
        sceneBytesTotal(db, scene.id),
      ]);
      if (privateBytes + flippedBytes > maxPrivateSceneBytesPerAccount) {
        return jsonError("storage_quota_exceeded", 403, {
          max_bytes: maxPrivateSceneBytesPerAccount,
          private_bytes: Math.round(privateBytes),
          scene_bytes: Math.round(flippedBytes),
        });
      }
    }
    changes.visibility = visibility;
  }

  if (typeof body.description === "string" || body.description === null) {
    changes.description =
      typeof body.description === "string"
        ? body.description.slice(0, 2000)
        : null;
  }

  if (body.tags !== undefined) {
    const tags = normalizeTags(body.tags);
    if (tags === undefined) {
      return jsonError("invalid_tags", 400);
    }
    changes.tags = tags;
  }

  // Category is a fixed taxonomy slug (or null to clear), so unlike tags it
  // needs no moderation pass.
  if (body.category !== undefined) {
    const category = normalizeCategory(body.category);
    if (category === undefined) {
      return jsonError("invalid_category", 400);
    }
    changes.category = category;
  }

  let requestedFrameosVersion: string | null | undefined;
  if (Object.hasOwn(body, "frameosVersion")) {
    if (body.frameosVersion === null || body.frameosVersion === "") {
      requestedFrameosVersion = null;
    } else {
      requestedFrameosVersion = normalizeFrameosVersion(body.frameosVersion);
      if (requestedFrameosVersion === undefined) {
        return jsonError("invalid_frameos_version", 400);
      }
    }
    changes.frameosVersion = requestedFrameosVersion;
  }

  if (Object.keys(changes).length === 0) {
    return jsonError("nothing_to_update", 400);
  }

  // Edits that (will) show on public pages pass the same moderation gate as
  // publishing: a changed description or tags, or flipping a scene public
  // re-checks the whole listing (name + description + preview image).
  const makingPublic =
    changes.visibility === "public" && scene.visibility !== "public";
  const editedDescription = changes.description;
  const editedTags = changes.tags?.length ? changes.tags.join(" ") : undefined;
  if (makingPublic || typeof editedDescription === "string" || editedTags) {
    const moderation = await moderateStoreContent({
      texts: makingPublic
        ? [scene.name, editedDescription ?? scene.description, editedTags]
        : [editedDescription, editedTags],
      ...(makingPublic && scene.previewImage
        ? {
            image: {
              content: scene.previewImage,
              contentType: scene.previewImageType ?? "image/jpeg",
            },
          }
        : {}),
    });
    if (!moderation.ok) {
      if (moderation.error === "content_rejected") {
        await recordAuditEvent(db, {
          accountId: session.accountId,
          actor: {
            accountId: session.accountId,
            providerSubject: session.providerSubject,
          },
          eventType: "store.publish_rejected",
          metadata: { categories: moderation.categories, name: scene.name },
          target: { sceneId: scene.id },
        });
        return jsonError("content_rejected", 422, {
          categories: moderation.categories,
        });
      }
      return jsonError("moderation_unavailable", 503);
    }
  }

  const frameosVersionChanged =
    requestedFrameosVersion !== undefined &&
    requestedFrameosVersion !== scene.frameosVersion;
  let nextVersionContent: Buffer | undefined;
  if (frameosVersionChanged) {
    const [latest] = await db
      .select({
        content: storeSceneVersions.content,
        objectKey: storeSceneVersions.objectKey,
      })
      .from(storeSceneVersions)
      .where(
        and(
          eq(storeSceneVersions.sceneId, scene.id),
          eq(storeSceneVersions.version, scene.latestVersion),
        ),
      )
      .limit(1);
    const latestContent = await readBlob(latest);
    if (!latestContent) {
      return jsonError("version_not_found", 404);
    }
    nextVersionContent = rebuildZipWithFrameosVersion(
      Buffer.from(latestContent),
      requestedFrameosVersion ?? null,
    );
    if (!nextVersionContent) {
      return jsonError("invalid_scene_zip", 500);
    }
    if (nextVersionContent.length > maxSceneZipBytes) {
      return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
    }
    const validated = validateSceneZip(nextVersionContent);
    if (!validated.ok) {
      return jsonError(validated.error, 400);
    }
    changes.latestVersion = scene.latestVersion + 1;
  }

  // Outside the transaction on purpose: the upload is a network call, and a
  // transaction held open across it would pin a Postgres connection for its
  // duration. A stored object with no row pointing at it is harmless (the
  // key is its digest, so the next publish of the same bytes re-uses it).
  const storedVersion =
    frameosVersionChanged && nextVersionContent
      ? await storeBlob(
          blobNamespaces.sceneVersion,
          nextVersionContent,
          "application/zip",
          { extension: "zip" },
        )
      : undefined;

  const updated = await db.transaction(async (tx) => {
    if (storedVersion) {
      await tx.insert(storeSceneVersions).values({
        contentType: "application/zip",
        frameosVersion: requestedFrameosVersion ?? null,
        objectKey: storedVersion.objectKey,
        riskFlags: scene.riskFlags,
        sceneId: scene.id,
        sha256: storedVersion.sha256,
        sizeBytes: storedVersion.sizeBytes,
        version: scene.latestVersion + 1,
      });
    }
    const [row] = await tx
      .update(storeScenes)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(storeScenes.id, scene.id))
      .returning();
    return row;
  });

  if (!updated) {
    return jsonError("scene_update_failed", 500);
  }

  if (changes.visibility && changes.visibility !== scene.visibility) {
    await recordAuditEvent(db, {
      accountId: session.accountId,
      actor: {
        accountId: session.accountId,
        providerSubject: session.providerSubject,
      },
      eventType: "store.visibility_changed",
      metadata: { name: scene.name, visibility: changes.visibility },
      target: { sceneId: scene.id },
    });
  }

  if (frameosVersionChanged) {
    await recordAuditEvent(db, {
      accountId: session.accountId,
      actor: {
        accountId: session.accountId,
        providerSubject: session.providerSubject,
      },
      eventType: "store.frameos_version_changed",
      metadata: {
        frameosVersion: requestedFrameosVersion,
        name: scene.name,
        version: scene.latestVersion + 1,
      },
      target: { sceneId: scene.id },
    });
  }

  return NextResponse.json({ scene: sceneSummary(updated), status: "updated" });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { db, errorResponse, scene, session } = await loadOwnedScene(
    request,
    context,
  );
  if (!scene || !db || !session) {
    return errorResponse;
  }

  await db.delete(storeScenes).where(eq(storeScenes.id, scene.id));

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "store.scene_deleted",
    metadata: { name: scene.name, visibility: scene.visibility },
    target: { sceneId: scene.id },
  });

  return NextResponse.json({ status: "deleted" });
}
