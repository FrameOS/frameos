import { and, eq, gt, sql } from "drizzle-orm";
import {
  accounts,
  type createDb,
  storeScenes,
} from "@frameos-cloud/db";
import { NextResponse } from "next/server";
import { recordAuditEvent } from "./audit";
import { jsonError } from "./device-flow";
import { logWarn } from "./log";
import { getScenesBaseUrl } from "./env";
import { moderateStoreContent } from "./moderation";
import { meterAiUsage } from "./billing";
import { classifyStoreScene } from "./store-classify";
import {
  detectImageContentType,
  maxNewScenesPerDay,
  maxScenesPerAccount,
  maxSceneZipBytes,
  sceneSummary,
  slugifyName,
  slugSuffix,
  validateSceneZip,
  compiledSceneHint,
} from "./store";
import {
  imageSetForVersion,
  registerStoreImage,
  type StoreImage,
} from "./store-images";
import type { SceneListing } from "./store-listing";
import { alignZipCover, writeSceneVersion } from "./store-version-write";
import {
  maxPrivateSceneBytesPerAccount,
  privateSceneBytesForAccount,
  sceneBytesTotal,
} from "./usage";

export type PublishActor =
  | { accountId: string; providerSubject: string }
  | { linkedClientId: string };

// Shared publishing path for linked FrameOS clients and signed-in web
// uploads. Both entry points get identical ZIP validation, moderation,
// versioning, quotas, and audit behavior.
//
// The zip is one version's worth of scene: its scenes.json, the listing in
// its template.json, and one cover (image.jpg). On an existing scene the
// listing fields the manifest carries replace the row's; the ones it omits
// are kept. The cover, when the zip has one, leads the image set and the
// previous version's images follow; without one the set is inherited.
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
  const content = input.content;

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

  const validation = validateSceneZip(content);
  if (!validation.ok) {
    return jsonError(validation.error, 400);
  }
  const validated = validation.value;
  if (validated.compiledScenes.length > 0) {
    // Counted: the number of refusals is how many people still hit the
    // legacy path from the cloud side.
    logWarn("store.publish.refused_compiled_scene", {
      accountId,
      scenes: validated.compiledScenes.length,
    });
    return jsonError("scene_requires_compilation", 400, {
      hint: compiledSceneHint,
      scenes: validated.compiledScenes,
    });
  }
  const uploadedPreview = validated.previewImage;

  const name = (input.name ?? validated.manifestName)
    ?.trim()
    .slice(0, 128);
  if (!name) {
    return jsonError("invalid_name", 400);
  }

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

  const description =
    input.description?.trim().slice(0, 2000) ||
    validated.manifestDescription ||
    existing?.description ||
    null;
  const previousImages: StoreImage[] = existing
    ? await imageSetForVersion(db, existing.id, null)
    : [];

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
    // A version pushed onto an already-private scene adds `content.length`
    // (plus a new cover); if this publish also flips a public scene private,
    // its existing bytes start counting too — fold them in so the flip
    // cannot dodge the quota.
    const flippingPrivateBytes =
      existing && existing.visibility === "public"
        ? await sceneBytesTotal(db, existing.id)
        : 0;
    if (
      privateBytes +
        flippingPrivateBytes +
        content.length +
        (uploadedPreview?.length ?? 0) >
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
    texts: [name, description, validated.manifestTags?.join(" ")],
    ...(uploadedPreview
      ? {
          image: {
            content: uploadedPreview,
            contentType: detectImageContentType(uploadedPreview) ?? "image/jpeg",
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

  // The listing this version records. Manifest values win where present;
  // otherwise the row's stand (a re-publish keeps the tags the owner set).
  const category =
    validated.manifestCategory !== undefined
      ? validated.manifestCategory
      : (existing?.category ?? null);
  const tags = validated.manifestTags ?? existing?.tags ?? [];

  // Auto-categorize: new scenes (and republishes of scenes that never got a
  // category) are classified into the fixed store taxonomy, and get suggested
  // tags when the owner has not set any. Owner-set values are never
  // overwritten, and a classifier outage just leaves the scene uncategorized.
  const classified = category
    ? undefined
    : await classifyStoreScene({
        appKeywords: validated.appKeywords,
        description,
        existingTags: tags,
        name,
      });
  if (classified) {
    // The classifier runs on the operator's key: our cost, the publisher's
    // benefit, nobody's charge. Metered all the same — an unmetered model
    // call is spend the books cannot explain.
    await meterAiUsage({
      accountId,
      credentialSource: "shared",
      model: classified.model,
      rounds: 1,
      surface: "store_classify",
      turnId: crypto.randomUUID(),
      usage: classified.usage,
    });
  }
  const listing: SceneListing = {
    category: category ?? classified?.category ?? null,
    description,
    frameosVersion: validated.frameosVersion ?? null,
    tags: tags.length ? tags : (classified?.tags ?? []),
  };

  const scene = existing ?? (await createScene(db, accountId, name));
  if (!scene) {
    return jsonError("scene_create_failed", 500);
  }

  // The zip's cover leads the set; the previous version's images follow,
  // minus the cover itself when it was already among them.
  let images = previousImages;
  if (uploadedPreview) {
    const cover = await registerStoreImage(db, uploadedPreview, undefined, {
      height: validated.imageHeight,
      width: validated.imageWidth,
    });
    images = [cover, ...previousImages.filter((image) => image.sha256 !== cover.sha256)];
  }
  const aligned = await alignZipCover(content, validated, images);
  if ("error" in aligned) {
    return jsonError(
      aligned.error,
      aligned.error === "scene_too_large" ? 413 : aligned.error === "image_not_found" ? 404 : 500,
    );
  }

  const nextVersion = scene.latestVersion + 1;
  const written = await writeSceneVersion(db, {
    content: aligned.content,
    images,
    listing,
    ...(linkedClientId ? { publishedByLinkedClientId: linkedClientId } : {}),
    rowChanges: {
      // A direct web upload clears the install attribution because no linked
      // FrameOS client published this latest version.
      linkedClientId: linkedClientId ?? null,
      name,
      // An omitted visibility keeps an existing scene's setting and lets the
      // database default new scenes to private.
      ...(input.visibility ? { visibility: input.visibility } : {}),
    },
    sceneId: scene.id,
    validated: aligned.validated,
    version: nextVersion,
  });
  if ("error" in written) {
    return jsonError("scene_publish_failed", 500);
  }
  const { updated } = written;

  await recordAuditEvent(db, {
    accountId,
    actor,
    eventType: "store.scene_published",
    metadata: {
      name: updated.name,
      sceneCount: validated.sceneCount,
      sizeBytes: aligned.content.length,
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
