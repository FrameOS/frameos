import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  storeSceneImages,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { sha256Hex } from "../../../../../../src/lib/backups";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import { moderateStoreContent } from "../../../../../../src/lib/moderation";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";
import {
  maxNewScenesPerDay,
  maxSceneZipBytes,
  maxScenesPerAccount,
  maxStoreBytesPerAccount,
  rebuildZipWithScenes,
  sceneSummary,
  slugifyName,
  slugSuffix,
  validateSceneZip,
} from "../../../../../../src/lib/store";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// Fork a scene: create a NEW private store scene under the caller's account,
// seeded with the posted scenes JSON inside a copy of the source's latest
// zip (manifest renamed, preview image carried over). Any signed-in user can
// fork a public scene — that is the "save an edited playground copy" path —
// and owners can fork their own scenes regardless of visibility.
export async function POST(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = rateLimitResponse(request, "account:scenes", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const accountId = session.accountId;

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const { sceneId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(sceneId)) {
    return jsonError("scene_not_found", 404);
  }

  const [source] = await db
    .select()
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId))
    .limit(1);
  const sourceVisible =
    source &&
    (source.accountId === accountId ||
      (source.visibility === "public" && source.status === "active"));
  if (!source || !sourceVisible) {
    return jsonError("scene_not_found", 404);
  }

  const body = await readJsonObject(request);
  if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
    return jsonError("invalid_scenes", 400);
  }

  // Same per-account quotas as publishing a new scene.
  const [quota] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${storeSceneVersions.sizeBytes}), 0)::bigint`,
      scenes: sql<number>`count(distinct ${storeScenes.id})::int`,
    })
    .from(storeScenes)
    .leftJoin(
      storeSceneVersions,
      eq(storeSceneVersions.sceneId, storeScenes.id),
    )
    .where(eq(storeScenes.accountId, accountId));
  if ((quota?.scenes ?? 0) >= maxScenesPerAccount) {
    return jsonError("scene_quota_exceeded", 403, {
      max_scenes: maxScenesPerAccount,
    });
  }
  const dailyLimited = identityRateLimitResponse(accountId, "store:fork", {
    limit: maxNewScenesPerDay,
    windowMs: 24 * 60 * 60 * 1000,
  });
  if (dailyLimited) {
    return dailyLimited;
  }

  const [latest] = await db
    .select({
      content: storeSceneVersions.content,
      frameosVersion: storeSceneVersions.frameosVersion,
    })
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, source.id),
        isNull(storeSceneVersions.yankedAt),
      ),
    )
    .orderBy(desc(storeSceneVersions.version))
    .limit(1);
  if (!latest) {
    return jsonError("version_not_found", 404);
  }

  const sourceImages = await db
    .select({
      content: storeSceneImages.content,
      contentType: storeSceneImages.contentType,
      createdAt: storeSceneImages.createdAt,
      position: storeSceneImages.position,
    })
    .from(storeSceneImages)
    .where(eq(storeSceneImages.sceneId, source.id))
    .orderBy(storeSceneImages.position, storeSceneImages.createdAt);

  // "<name> (copy)", with a counter when the account already owns that name
  // (the publish flow treats same-owner names as new versions; a fork must
  // always be a distinct scene).
  const ownedNames = new Set(
    (
      await db
        .select({ name: storeScenes.name })
        .from(storeScenes)
        .where(eq(storeScenes.accountId, accountId))
    ).map((row) => row.name.toLowerCase()),
  );
  let name = `${source.name} (copy)`.slice(0, 128);
  for (let counter = 2; ownedNames.has(name.toLowerCase()); counter += 1) {
    if (counter > 50) {
      return jsonError("too_many_copies", 400);
    }
    name = `${source.name} (copy ${counter})`.slice(0, 128);
  }

  const content = rebuildZipWithScenes(
    Buffer.from(latest.content),
    JSON.stringify(body.scenes, null, 2),
    name,
  );
  if (!content) {
    return jsonError("invalid_scene_zip", 500);
  }
  if (content.length > maxSceneZipBytes) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }
  if (Number(quota?.bytes ?? 0) + content.length > maxStoreBytesPerAccount) {
    return jsonError("storage_quota_exceeded", 403, {
      max_bytes: maxStoreBytesPerAccount,
    });
  }

  const validated = validateSceneZip(content);
  if (!validated.ok) {
    return jsonError(validated.error, 400);
  }

  // The name is new text on a (future) public page; the description and
  // preview image carry over from an already-hosted scene.
  const moderation = await moderateStoreContent({
    texts: [name, source.description],
  });
  if (!moderation.ok) {
    if (moderation.error === "content_rejected") {
      return jsonError("content_rejected", 422, {
        categories: moderation.categories,
      });
    }
    return jsonError("moderation_unavailable", 503);
  }

  const base = slugifyName(name);
  const result = await db.transaction(async (tx) => {
    // Globally unique slug, random suffix on collision (same as publishing).
    let created;
    for (const candidate of [
      base,
      `${base}-${slugSuffix()}`,
      `${base}-${slugSuffix()}`,
    ]) {
      [created] = await tx
        .insert(storeScenes)
        .values({ accountId, name, slug: candidate })
        .onConflictDoNothing({ target: storeScenes.slug })
        .returning();
      if (created) {
        break;
      }
    }
    if (!created) {
      return { error: "scene_create_failed" as const };
    }

    await tx.insert(storeSceneVersions).values({
      content,
      contentType: "application/zip",
      frameosVersion: validated.value.frameosVersion ?? latest.frameosVersion,
      riskFlags: validated.value.riskFlags,
      sceneId: created.id,
      sha256: sha256Hex(content),
      sizeBytes: content.length,
      version: 1,
    });

    const [updated] = await tx
      .update(storeScenes)
      .set({
        description: source.description,
        frameosVersion: validated.value.frameosVersion ?? latest.frameosVersion,
        latestVersion: 1,
        previewImage: source.previewImage,
        previewImageHeight: source.previewImageHeight,
        previewImageType: source.previewImageType,
        previewImageWidth: source.previewImageWidth,
        riskFlags: validated.value.riskFlags,
        tags: source.tags,
        updatedAt: new Date(),
        visibility: "private",
      })
      .where(eq(storeScenes.id, created.id))
      .returning();
    if (!updated) {
      return { error: "scene_fork_failed" as const };
    }

    if (sourceImages.length > 0) {
      await tx.insert(storeSceneImages).values(
        sourceImages.map((image) => ({
          content: image.content,
          contentType: image.contentType,
          createdAt: image.createdAt,
          position: image.position,
          sceneId: updated.id,
        })),
      );
    }

    return { updated };
  });

  if ("error" in result) {
    return jsonError(result.error, 500);
  }
  const { updated } = result;

  await recordAuditEvent(db, {
    accountId,
    actor: {
      accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "store.scene_forked",
    metadata: {
      name: updated.name,
      imageCount: sourceImages.length,
      sceneCount: validated.value.sceneCount,
      sourceSceneId: source.id,
      sourceSceneName: source.name,
    },
    target: { sceneId: updated.id },
  });

  return NextResponse.json({
    scene: sceneSummary({ ...updated, latestVersion: 1 }),
    status: "forked",
  });
}
