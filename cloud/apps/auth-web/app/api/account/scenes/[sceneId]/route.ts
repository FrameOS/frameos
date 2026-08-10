import { and, eq, lt } from "drizzle-orm";
import { storeScenes, storeSceneVersions } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { sha256Hex } from "../../../../../src/lib/backups";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
} from "../../../../../src/lib/device-flow";
import { normalizeCategory } from "../../../../../src/lib/categories";
import { moderateStoreContent } from "../../../../../src/lib/moderation";
import {
  maxSceneZipBytes,
  maxVersionsPerScene,
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
      .select({ content: storeSceneVersions.content })
      .from(storeSceneVersions)
      .where(
        and(
          eq(storeSceneVersions.sceneId, scene.id),
          eq(storeSceneVersions.version, scene.latestVersion),
        ),
      )
      .limit(1);
    if (!latest) {
      return jsonError("version_not_found", 404);
    }
    nextVersionContent = rebuildZipWithFrameosVersion(
      Buffer.from(latest.content),
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

  const updated = await db.transaction(async (tx) => {
    if (frameosVersionChanged && nextVersionContent) {
      await tx.insert(storeSceneVersions).values({
        content: nextVersionContent,
        contentType: "application/zip",
        frameosVersion: requestedFrameosVersion ?? null,
        riskFlags: scene.riskFlags,
        sceneId: scene.id,
        sha256: sha256Hex(nextVersionContent),
        sizeBytes: nextVersionContent.length,
        version: scene.latestVersion + 1,
      });
      await tx
        .delete(storeSceneVersions)
        .where(
          and(
            eq(storeSceneVersions.sceneId, scene.id),
            lt(
              storeSceneVersions.version,
              scene.latestVersion + 1 - maxVersionsPerScene + 1,
            ),
          ),
        );
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
