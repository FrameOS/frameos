import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import {
  accounts,
  type createDb,
  storeSceneImages,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { NextResponse } from "next/server";
import { recordAuditEvent } from "./audit";
import { sha256Hex } from "./backups";
import { jsonError } from "./device-flow";
import { getScenesBaseUrl } from "./env";
import { moderateStoreContent } from "./moderation";
import { classifyStoreScene } from "./store-classify";
import {
  detectImageContentType,
  maxNewScenesPerDay,
  maxScenesPerAccount,
  maxSceneZipBytes,
  maxVersionsPerScene,
  rebuildZipWithPreview,
  sceneSummary,
  slugifyName,
  slugSuffix,
  validateSceneZip,
} from "./store";
import {
  maxPrivateSceneBytesPerAccount,
  privateSceneBytesForAccount,
  sceneBytesTotal,
} from "./usage";

type PublishActor =
  | { accountId: string; providerSubject: string }
  | { linkedClientId: string };

// Shared publishing path for linked FrameOS clients and signed-in web
// uploads. Both entry points get identical ZIP validation, moderation,
// versioning, quotas, and audit behavior.
export async function publishStoreScene(
  db: ReturnType<typeof createDb>,
  input: {
    accountId: string;
    actor: PublishActor;
    content: Buffer;
    description?: string | undefined;
    linkedClientId?: string | undefined;
    name?: string | undefined;
    visibility?: string | undefined;
  },
) {
  const { accountId, actor, linkedClientId } = input;
  let content = input.content;

  const [publisher] = await db
    .select({ storeBannedAt: accounts.storeBannedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (publisher?.storeBannedAt) {
    return jsonError("store_banned", 403);
  }

  if (content.length === 0) {
    return jsonError("invalid_content", 400);
  }
  if (content.length > maxSceneZipBytes) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }

  let validated = validateSceneZip(content);
  if (!validated.ok) {
    return jsonError(validated.error, 400);
  }
  // Keep these separate from the effective ZIP preview: a gallery fallback
  // belongs in the archive, but must not be duplicated into the primary
  // storefront image column.
  const uploadedPreview = validated.value.previewImage;
  const uploadedPreviewHeight = validated.value.imageHeight;
  const uploadedPreviewWidth = validated.value.imageWidth;

  const name = (input.name ?? validated.value.manifestName)
    ?.trim()
    .slice(0, 128);
  if (!name) {
    return jsonError("invalid_name", 400);
  }
  const description =
    input.description?.trim().slice(0, 2000) ??
    validated.value.manifestDescription ??
    null;

  // Same account + same name (case-insensitive) is a new immutable version.
  const [existing] = await db
    .select()
    .from(storeScenes)
    .where(
      and(
        eq(storeScenes.accountId, accountId),
        sql`lower(${storeScenes.name}) = lower(${name})`,
      ),
    )
    .limit(1);

  if (existing?.status === "pulled") {
    return jsonError("scene_pulled", 403);
  }

  // A newly published ZIP may omit its own image while this existing scene
  // still has a cloud gallery. Fold the gallery lead into this same immutable
  // version so publishing cannot put the page and its download out of sync.
  if (existing && !uploadedPreview) {
    const [galleryLead] = await db
      .select({ content: storeSceneImages.content })
      .from(storeSceneImages)
      .where(eq(storeSceneImages.sceneId, existing.id))
      .orderBy(asc(storeSceneImages.position), asc(storeSceneImages.createdAt))
      .limit(1);
    if (galleryLead) {
      const rebuilt = rebuildZipWithPreview(
        content,
        Buffer.from(galleryLead.content),
      );
      if (!rebuilt) {
        return jsonError("invalid_scene_zip", 500);
      }
      if (rebuilt.length > maxSceneZipBytes) {
        return jsonError("scene_too_large", 413, {
          max_bytes: maxSceneZipBytes,
        });
      }
      const rebuiltValidation = validateSceneZip(rebuilt);
      if (!rebuiltValidation.ok) {
        return jsonError(rebuiltValidation.error, 400);
      }
      content = rebuilt;
      validated = rebuiltValidation;
    }
  }

  const [sceneCountRow] = await db
    .select({ scenes: sql<number>`count(*)::int` })
    .from(storeScenes)
    .where(eq(storeScenes.accountId, accountId));
  if (!existing && (sceneCountRow?.scenes ?? 0) >= maxScenesPerAccount) {
    return jsonError("scene_quota_exceeded", 403, {
      max_scenes: maxScenesPerAccount,
    });
  }
  // Only PRIVATE scenes are metered — publishing publicly is free. The check
  // uses the visibility this publish RESULTS in: an omitted visibility keeps
  // an existing scene's setting and defaults a new scene to private.
  const resultingVisibility =
    input.visibility ?? existing?.visibility ?? "private";
  if (resultingVisibility !== "public") {
    const privateBytes = await privateSceneBytesForAccount(db, accountId);
    // A version pushed onto an already-private scene adds `content.length`;
    // if this publish also flips a public scene private, its existing bytes
    // start counting too — fold them in so the flip cannot dodge the quota.
    const flippingPrivateBytes =
      existing && existing.visibility === "public"
        ? await sceneBytesTotal(db, existing.id)
        : 0;
    if (
      privateBytes + flippingPrivateBytes + content.length >
      maxPrivateSceneBytesPerAccount
    ) {
      return jsonError("storage_quota_exceeded", 403, {
        max_bytes: maxPrivateSceneBytesPerAccount,
        private_bytes: Math.round(privateBytes),
      });
    }
  }
  if (!existing) {
    const [recent] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(storeScenes)
      .where(
        and(
          eq(storeScenes.accountId, accountId),
          gt(storeScenes.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
        ),
      );
    if ((recent?.count ?? 0) >= maxNewScenesPerDay) {
      return jsonError("daily_scene_limit_exceeded", 429, {
        max_new_scenes_per_day: maxNewScenesPerDay,
      });
    }
  }

  const moderation = await moderateStoreContent({
    texts: [name, description],
    ...(uploadedPreview
      ? {
          image: {
            content: uploadedPreview,
            contentType: "image/jpeg",
          },
        }
      : {}),
  });
  if (!moderation.ok) {
    if (moderation.error === "content_rejected") {
      await recordAuditEvent(db, {
        accountId,
        actor,
        eventType: "store.publish_rejected",
        metadata: { categories: moderation.categories, name },
      });
      return jsonError("content_rejected", 422, {
        categories: moderation.categories,
      });
    }
    return jsonError("moderation_unavailable", 503);
  }

  // Auto-categorize: new scenes (and republishes of scenes that never got a
  // category) are classified into the fixed store taxonomy, and get suggested
  // tags when the owner has not set any. Owner-set values are never
  // overwritten, and a classifier outage just leaves the scene uncategorized.
  const classified = existing?.category
    ? undefined
    : await classifyStoreScene({
        appKeywords: validated.value.appKeywords,
        description,
        existingTags: existing?.tags,
        name,
      });

  const scene = existing ?? (await createScene(db, accountId, name));
  if (!scene) {
    return jsonError("scene_create_failed", 500);
  }

  const nextVersion = scene.latestVersion + 1;
  await db.insert(storeSceneVersions).values({
    content,
    contentType: "application/zip",
    frameosVersion: validated.value.frameosVersion ?? null,
    ...(linkedClientId ? { publishedByLinkedClientId: linkedClientId } : {}),
    riskFlags: validated.value.riskFlags,
    sceneId: scene.id,
    sha256: sha256Hex(content),
    sizeBytes: content.length,
    version: nextVersion,
  });

  await db
    .delete(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, scene.id),
        lt(storeSceneVersions.version, nextVersion - maxVersionsPerScene + 1),
      ),
    );

  const [updated] = await db
    .update(storeScenes)
    .set({
      ...(classified ? { category: classified.category } : {}),
      ...(classified && !existing?.tags.length && classified.tags.length
        ? { tags: classified.tags }
        : {}),
      description,
      frameosVersion: validated.value.frameosVersion ?? null,
      latestVersion: nextVersion,
      // A direct web upload clears the install attribution because no linked
      // FrameOS client published this latest version.
      linkedClientId: linkedClientId ?? null,
      name,
      previewImage: uploadedPreview ?? null,
      previewImageHeight: uploadedPreviewHeight ?? null,
      // The zip's conventional image.jpg path says nothing about the real
      // format — PNG/WebP/GIF bytes are stored untranscoded, so sniff them.
      previewImageType: uploadedPreview
        ? detectImageContentType(uploadedPreview) ?? "image/jpeg"
        : null,
      previewImageWidth: uploadedPreviewWidth ?? null,
      riskFlags: validated.value.riskFlags,
      updatedAt: new Date(),
      // An omitted visibility keeps an existing scene's setting and lets the
      // database default new scenes to private.
      ...(input.visibility ? { visibility: input.visibility } : {}),
    })
    .where(eq(storeScenes.id, scene.id))
    .returning();

  if (!updated) {
    return jsonError("scene_publish_failed", 500);
  }

  await recordAuditEvent(db, {
    accountId,
    actor,
    eventType: "store.scene_published",
    metadata: {
      name: updated.name,
      sceneCount: validated.value.sceneCount,
      sizeBytes: content.length,
      version: nextVersion,
      visibility: updated.visibility,
    },
    target: { sceneId: updated.id },
  });

  return NextResponse.json({
    scene: {
      ...sceneSummary(updated),
      url: new URL(`/s/${updated.slug}`, getScenesBaseUrl()).toString(),
      version: nextVersion,
    },
    status: "published",
  });
}

async function createScene(
  db: ReturnType<typeof createDb>,
  accountId: string,
  name: string,
) {
  const base = slugifyName(name);
  for (const candidate of [
    base,
    `${base}-${slugSuffix()}`,
    `${base}-${slugSuffix()}`,
    `${base}-${slugSuffix()}`,
  ]) {
    const [created] = await db
      .insert(storeScenes)
      .values({ accountId, name, slug: candidate })
      .onConflictDoNothing({ target: storeScenes.slug })
      .returning();
    if (created) {
      return created;
    }
  }
  return undefined;
}
