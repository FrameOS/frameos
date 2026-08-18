// Fork a store scene into a NEW private scene under the caller's account.
//
// Extracted from app/api/account/scenes/[sceneId]/fork/route.ts so the AI
// chat's save_scene tool (given a `source_scene_id`) records the SAME lineage
// the workspace's fork button does: the source scene id in the audit event,
// the carried-over preview image, gallery images, tags and description. A
// tool with its own "save these bytes as a new scene" path would fork a store
// scene in practice while recording none of that.
//
// The caller owns authentication, CSRF and per-IP rate limiting; pass an
// accountId that is already proven. Per-account quotas and the daily fork
// limit live here, because they are policy on the fork itself.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  createDb,
  storeSceneImages,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { NextResponse } from "next/server";
import {
  availableSceneName,
  withAccountSceneNameLock,
} from "./account-scene-create";
import { recordAuditEvent } from "./audit";
import { blobNamespaces, readBlob, storeBlob } from "./blobs";
import { jsonError } from "./device-flow";
import { moderateStoreContent } from "./moderation";
import { identityRateLimitResponse } from "./rate-limit";
import {
  maxNewScenesPerDay,
  maxSceneZipBytes,
  maxScenesPerAccount,
  rebuildZipWithScenes,
  sceneSummary,
  slugifyName,
  slugSuffix,
  validateSceneZip,
} from "./store";
import type { PublishActor } from "./store-publish";
import {
  maxPrivateSceneBytesPerAccount,
  privateSceneBytesForAccount,
} from "./usage";

type Database = ReturnType<typeof createDb>;

export const sceneIdPattern = /^[0-9a-f-]{36}$/i;

/** Returns the fork route's response (or a jsonError) — the route hands it
 *  straight back, the AI tool reads its JSON body. */
export async function forkStoreScene(
  db: Database,
  input: ForkInput,
) {
  if (!sceneIdPattern.test(input.sourceSceneId)) {
    return jsonError("scene_not_found", 404);
  }
  if (!Array.isArray(input.scenes) || input.scenes.length === 0) {
    return jsonError("invalid_scenes", 400);
  }
  // Same check-then-insert on the copy's name as the plain save path, same
  // per-account lock so two racing forks cannot both land on "(copy 3)".
  return withAccountSceneNameLock(db, input.accountId, (locked) =>
    forkStoreSceneLocked(locked, input),
  );
}

type ForkInput = {
  accountId: string;
  actor: PublishActor;
  /** Optional description override; the source's carries over otherwise. */
  description?: string | undefined;
  /** Optional name for the copy; defaults to "<source name> (copy)". Either
   *  way the account never ends up with two scenes of the same name. */
  name?: string | undefined;
  scenes: unknown[];
  sourceSceneId: string;
  /** Free-text tag for the audit event ("ai_chat"); the web route omits it. */
  via?: string | undefined;
};

async function forkStoreSceneLocked(db: Database, input: ForkInput) {
  const { accountId, actor, sourceSceneId } = input;

  // Any signed-in user can fork a public scene — that is the "save an edited
  // playground copy" path — and owners can fork their own scenes regardless
  // of visibility.
  const [source] = await db
    .select()
    .from(storeScenes)
    .where(eq(storeScenes.id, sourceSceneId))
    .limit(1);
  const sourceVisible =
    source &&
    (source.accountId === accountId ||
      (source.visibility === "public" && source.status === "active"));
  if (!source || !sourceVisible) {
    return jsonError("scene_not_found", 404);
  }

  // Same per-account quotas as publishing a new scene. Forks are born
  // private, so their bytes always count against the private-scene quota.
  const [quota] = await db
    .select({ scenes: sql<number>`count(*)::int` })
    .from(storeScenes)
    .where(eq(storeScenes.accountId, accountId));
  if ((quota?.scenes ?? 0) >= maxScenesPerAccount) {
    return jsonError("scene_quota_exceeded", 403, {
      max_scenes: maxScenesPerAccount,
    });
  }
  const privateBytes = await privateSceneBytesForAccount(db, accountId);
  const dailyLimited = await identityRateLimitResponse(accountId, "store:fork", {
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
      objectKey: storeSceneVersions.objectKey,
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
  const latestContent = await readBlob(latest);
  if (!latestContent) {
    return jsonError("version_not_found", 404);
  }

  // Copied by reference, not by value: object keys are content digests, so a
  // fork of a 6 MB scene pack re-uses the same objects and uploads nothing.
  // Legacy rows that still hold their bytes in Postgres copy those instead.
  const sourceImages = await db
    .select({
      content: storeSceneImages.content,
      contentType: storeSceneImages.contentType,
      createdAt: storeSceneImages.createdAt,
      objectKey: storeSceneImages.objectKey,
      position: storeSceneImages.position,
      sizeBytes: storeSceneImages.sizeBytes,
    })
    .from(storeSceneImages)
    .where(eq(storeSceneImages.sceneId, source.id))
    .orderBy(storeSceneImages.position, storeSceneImages.createdAt);

  const name = await forkName(db, accountId, source.name, input.name);
  if (!name) {
    return jsonError("too_many_copies", 400);
  }
  const description = input.description?.trim() || source.description;

  const content = rebuildZipWithScenes(
    Buffer.from(latestContent),
    JSON.stringify(input.scenes, null, 2),
    name,
  );
  if (!content) {
    return jsonError("invalid_scene_zip", 500);
  }
  if (content.length > maxSceneZipBytes) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }
  if (privateBytes + content.length > maxPrivateSceneBytesPerAccount) {
    return jsonError("storage_quota_exceeded", 403, {
      max_bytes: maxPrivateSceneBytesPerAccount,
      private_bytes: Math.round(privateBytes),
    });
  }

  const validated = validateSceneZip(content);
  if (!validated.ok) {
    return jsonError(validated.error, 400);
  }

  // The name (and a caller-supplied description) is new text on a (future)
  // public page; the preview image carries over from an already-hosted scene.
  const moderation = await moderateStoreContent({
    texts: [name, description],
  });
  if (!moderation.ok) {
    if (moderation.error === "content_rejected") {
      return jsonError("content_rejected", 422, {
        categories: moderation.categories,
      });
    }
    return jsonError("moderation_unavailable", 503);
  }

  const storedFork = await storeBlob(
    blobNamespaces.sceneVersion,
    content,
    "application/zip",
    { extension: "zip" },
  );

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
      contentType: "application/zip",
      frameosVersion: validated.value.frameosVersion ?? latest.frameosVersion,
      objectKey: storedFork.objectKey,
      riskFlags: validated.value.riskFlags,
      sceneId: created.id,
      sha256: storedFork.sha256,
      sizeBytes: storedFork.sizeBytes,
      version: 1,
    });

    const [updated] = await tx
      .update(storeScenes)
      .set({
        description,
        frameosVersion: validated.value.frameosVersion ?? latest.frameosVersion,
        latestVersion: 1,
        previewImage: source.previewImage,
        previewImageHeight: source.previewImageHeight,
        previewImageSizeBytes: source.previewImageSizeBytes,
        previewImageType: source.previewImageType,
        previewImageWidth: source.previewImageWidth,
        previewObjectKey: source.previewObjectKey,
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
          objectKey: image.objectKey,
          position: image.position,
          sceneId: updated.id,
          sizeBytes: image.sizeBytes,
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
    actor,
    eventType: "store.scene_forked",
    metadata: {
      name: updated.name,
      imageCount: sourceImages.length,
      sceneCount: validated.value.sceneCount,
      sourceSceneId: source.id,
      sourceSceneName: source.name,
      ...(input.via ? { via: input.via } : {}),
    },
    target: { sceneId: updated.id },
  });

  return NextResponse.json({
    scene: sceneSummary({ ...updated, latestVersion: 1 }),
    status: "forked",
  });
}

// "<name> (copy)", with a counter when the account already owns that name
// (the publish flow treats same-owner names as new versions; a fork must
// always be a distinct scene). A requested name goes through the same
// "name 2" disambiguation the plain "save to my account" path uses.
async function forkName(
  db: Database,
  accountId: string,
  sourceName: string,
  requested: string | undefined,
): Promise<string | undefined> {
  if (requested?.trim()) {
    return availableSceneName(db, accountId, requested);
  }
  const ownedNames = new Set(
    (
      await db
        .select({ name: storeScenes.name })
        .from(storeScenes)
        .where(eq(storeScenes.accountId, accountId))
    ).map((row) => row.name.toLowerCase()),
  );
  let name = `${sourceName} (copy)`.slice(0, 128);
  for (let counter = 2; ownedNames.has(name.toLowerCase()); counter += 1) {
    if (counter > 50) {
      return undefined;
    }
    name = `${sourceName} (copy ${counter})`.slice(0, 128);
  }
  return name;
}
