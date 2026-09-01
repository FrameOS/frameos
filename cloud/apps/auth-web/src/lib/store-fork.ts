// Fork a store scene into a NEW private scene under the caller's account.
//
// Extracted from app/api/account/scenes/[sceneId]/fork/route.ts so the AI
// chat's save_scene tool (given a `source_scene_id`) records the SAME lineage
// the workspace's fork button does: the source scene id in the audit event,
// the carried-over images (linked, never copied), tags and description. A
// tool with its own "save these bytes as a new scene" path would fork a store
// scene in practice while recording none of that.
//
// The caller owns authentication, CSRF and per-IP rate limiting; pass an
// accountId that is already proven. Per-account quotas and the daily fork
// limit live here, because they are policy on the fork itself.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  createDb,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { NextResponse } from "next/server";
import {
  availableSceneName,
  withAccountSceneNameLock,
} from "./account-scene-create";
import { recordAuditEvent } from "./audit";
import { readBlob } from "./blobs";
import { jsonError } from "./device-flow";
import { moderateStoreContent } from "./moderation";
import { identityRateLimitResponse } from "./rate-limit";
import {
  maxNewScenesPerDay,
  maxSceneZipBytes,
  maxScenesPerAccount,
  rebuildZip,
  sceneSummary,
  slugifyName,
  slugSuffix,
  validateSceneZip,
} from "./store";
import { imageSetForVersion } from "./store-images";
import type { SceneListing } from "./store-listing";
import type { PublishActor } from "./store-publish";
import { alignZipCover, writeSceneVersion } from "./store-version-write";
import {
  accountLimits,
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

  // The source's image set carries over as links to the same rows — a fork
  // of a 6 MB scene pack uploads nothing and stores nothing twice.
  const sourceImages = await imageSetForVersion(db, source.id, null);

  const name = await forkName(db, accountId, source.name, input.name);
  if (!name) {
    return jsonError("too_many_copies", 400);
  }
  const description = input.description?.trim() || source.description;
  // The listing the copy starts from: the source's, minus its category —
  // a private copy is not on the shelf the original was filed under.
  const listing: SceneListing = {
    category: null,
    description,
    frameosVersion: latest.frameosVersion,
    tags: source.tags,
  };

  const rebuilt = rebuildZip(Buffer.from(latestContent), {
    manifest: {
      category: null,
      description,
      name,
      tags: source.tags,
    },
    scenesJson: JSON.stringify(input.scenes, null, 2),
  });
  if (!rebuilt) {
    return jsonError("invalid_scene_zip", 500);
  }
  if (rebuilt.length > maxSceneZipBytes) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }
  const { privateSceneBytes: maxPrivateBytes } = await accountLimits(db, accountId);
  if (privateBytes + rebuilt.length > maxPrivateBytes) {
    return jsonError("storage_quota_exceeded", 403, {
      max_bytes: maxPrivateBytes,
      private_bytes: Math.round(privateBytes),
    });
  }

  const validation = validateSceneZip(rebuilt);
  if (!validation.ok) {
    return jsonError(validation.error, 400);
  }
  listing.frameosVersion = validation.value.frameosVersion ?? latest.frameosVersion;
  const aligned = await alignZipCover(rebuilt, validation.value, sourceImages);
  if ("error" in aligned) {
    return jsonError(aligned.error, aligned.error === "scene_too_large" ? 413 : 500);
  }

  // The name (and a caller-supplied description) is new text on a (future)
  // public page; the images carry over from an already-hosted scene.
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

  // Globally unique slug, random suffix on collision (same as publishing).
  const base = slugifyName(name);
  let created;
  for (const candidate of [
    base,
    `${base}-${slugSuffix()}`,
    `${base}-${slugSuffix()}`,
  ]) {
    [created] = await db
      .insert(storeScenes)
      .values({ accountId, name, slug: candidate })
      .onConflictDoNothing({ target: storeScenes.slug })
      .returning();
    if (created) {
      break;
    }
  }
  if (!created) {
    return jsonError("scene_create_failed", 500);
  }

  const written = await writeSceneVersion(db, {
    content: aligned.content,
    images: sourceImages,
    listing,
    rowChanges: { visibility: "private" },
    sceneId: created.id,
    validated: aligned.validated,
    version: 1,
  });
  if ("error" in written) {
    await db.delete(storeScenes).where(eq(storeScenes.id, created.id));
    return jsonError("scene_fork_failed", 500);
  }
  const { updated } = written;

  await recordAuditEvent(db, {
    accountId,
    actor,
    eventType: "store.scene_forked",
    metadata: {
      name: updated.name,
      imageCount: sourceImages.length,
      sceneCount: aligned.validated.sceneCount,
      sourceSceneId: source.id,
      sourceSceneName: source.name,
      ...(input.via ? { via: input.via } : {}),
    },
    target: { sceneId: updated.id },
  });

  return NextResponse.json({
    scene: sceneSummary(updated),
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
