import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  storeSceneVersions,
  storeScenes,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { readBlob } from "../../../../../../src/lib/blobs";
import {
  defaultJsonBodyBytes,
  jsonError,
  readBoundedJsonObject,
} from "../../../../../../src/lib/device-flow";
import { moderateStoreContent } from "../../../../../../src/lib/moderation";
import { identityRateLimitResponse } from "../../../../../../src/lib/rate-limit";
import {
  extractManifestNameFromZip,
  extractScenesFromZip,
  sceneDisplayName,
} from "../../../../../../src/lib/scene-title";
import {
  maxSceneEditsPer15Minutes,
  maxSceneEditsPerHour,
  maxSceneZipBytes,
  normalizeVersionMessage,
  rebuildZip,
  sceneSummary,
  validateSceneZip,
} from "../../../../../../src/lib/store";
import {
  imageSetForVersion,
  resolveImageSet,
  sameImageSet,
} from "../../../../../../src/lib/store-images";
import {
  listingEquals,
  parseListingChanges,
  type SceneListing,
} from "../../../../../../src/lib/store-listing";
import { loadOwnedScene } from "../../../../../../src/lib/store-owner";
import {
  alignZipCover,
  writeSceneVersion,
} from "../../../../../../src/lib/store-version-write";
import {
  accountLimits,
  privateSceneBytesForAccount,
} from "../../../../../../src/lib/usage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// Owner publishing of a new version from the web: the editor's Save. A
// version is the whole scene — its scenes.json, its listing (description,
// tags, category, minimum FrameOS version) and its ordered image set — and
// this is the one route that writes one. Every part of the body is
// optional; what is left out is inherited: scenes from the previous
// version's zip, the listing from the scene row (the effective listing —
// where moderators' category edits land), the image set from the latest
// version. Versions never mutate; each Save appends.
export async function POST(request: NextRequest, context: RouteContext) {
  const { db, errorResponse, scene, session } = await loadOwnedScene(
    request,
    context,
    {
      rateLimit: {
        action: "account:scene-content",
        limit: maxSceneEditsPer15Minutes,
        windowMs: 15 * 60 * 1000,
      },
    },
  );
  if (!scene || !db || !session) {
    return errorResponse;
  }

  if (scene.status === "pulled") {
    return jsonError("scene_pulled", 403);
  }

  // Interactive editor saves have a separate, higher allowance than uploads
  // and linked-backend publishing so experimentation does not exhaust either.
  const accountLimited = await identityRateLimitResponse(
    session.accountId!,
    "store:scene-edit",
    { limit: maxSceneEditsPerHour, windowMs: 60 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }

  const parsed = await readBoundedJsonObject(request, defaultJsonBodyBytes);
  if (parsed.response) {
    return parsed.response;
  }
  const body = parsed.body;
  if (body.scenes !== undefined && (!Array.isArray(body.scenes) || body.scenes.length === 0)) {
    return jsonError("invalid_scenes", 400);
  }
  const listingInput =
    body.listing !== undefined
      ? typeof body.listing === "object" && body.listing !== null && !Array.isArray(body.listing)
        ? parseListingChanges(body.listing as Record<string, unknown>)
        : { error: "invalid_listing" }
      : undefined;
  if (listingInput && "error" in listingInput) {
    return jsonError(listingInput.error, 400);
  }
  const imagesInput = body.images !== undefined ? await resolveImageSet(db, body.images) : undefined;
  if (imagesInput && "error" in imagesInput) {
    return jsonError(imagesInput.error, imagesInput.error === "image_not_found" ? 404 : 400);
  }
  if (body.scenes === undefined && listingInput === undefined && imagesInput === undefined) {
    return jsonError("nothing_to_update", 400);
  }
  // The optional "what changed" note the save dialog asks for. It shows on
  // the public scene page, so it is moderated below with the name.
  const message = normalizeVersionMessage(body.message);

  const [latest] = await db
    .select({
      content: storeSceneVersions.content,
      frameosVersion: storeSceneVersions.frameosVersion,
      objectKey: storeSceneVersions.objectKey,
    })
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, scene.id),
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
  const latestZip = Buffer.from(latestContent);

  const previousScenes = extractScenesFromZip(latestZip);
  const scenes = (body.scenes as unknown[] | undefined) ?? previousScenes;
  if (!scenes || scenes.length === 0) {
    return jsonError("version_not_found", 404);
  }

  // The listing title lives in the zip's template.json (that is what publishing
  // reads into storeScenes.name, and what the /s/[slug] <h1>, the social card
  // and the frameos:name meta tag all render). The editor's gear → Rename only
  // touches the scene inside scenes.json, so without this the page kept showing
  // the pre-rename title forever. template.json stays authoritative; it just
  // follows the scene it was minted from.
  //
  // Only when the two were already in sync: a publisher who deliberately gave
  // the listing a different title from the scene keeps that title, and a
  // multi-scene pack is never retitled by an unrelated edit.
  const previousSceneName = sceneDisplayName(previousScenes);
  const nextSceneName = sceneDisplayName(scenes);
  let renameTo: string | undefined;
  if (
    body.scenes !== undefined &&
    nextSceneName &&
    previousSceneName &&
    nextSceneName !== previousSceneName &&
    previousSceneName === scene.name
  ) {
    // Publishing resolves "same account + same name" to an existing scene, so
    // two of an account's scenes sharing a name would make later publishes
    // ambiguous. Say so instead of silently keeping the old title.
    const [clash] = await db
      .select({ id: storeScenes.id })
      .from(storeScenes)
      .where(
        and(
          eq(storeScenes.accountId, scene.accountId),
          ne(storeScenes.id, scene.id),
          sql`lower(${storeScenes.name}) = lower(${nextSceneName})`,
        ),
      )
      .limit(1);
    if (clash) {
      return jsonError("scene_name_taken", 409, { name: nextSceneName });
    }
    renameTo = nextSceneName;
  }

  // The listing this version records: the effective one, with the edits.
  const current: SceneListing = {
    category: scene.category,
    description: scene.description,
    frameosVersion: scene.frameosVersion,
    tags: scene.tags,
  };
  const listing: SceneListing = { ...current, ...(listingInput?.changes ?? {}) };
  const listingChanged = !listingEquals(current, listing);

  // The image set this version records: the draft's, or the latest's.
  const previousImages = await imageSetForVersion(db, scene.id, null);
  const images = imagesInput?.images ?? previousImages;
  const imagesChanged = !sameImageSet(previousImages, images);

  // Text that shows on public pages passes the same gate publishing does —
  // one call for all of it, and none at all for the usual save that carries
  // nothing new. Images were moderated when they were uploaded.
  const descriptionChanged = listing.description !== current.description;
  const tagsChanged = listing.tags.join(" ") !== current.tags.join(" ");
  if (renameTo || message || descriptionChanged || tagsChanged) {
    const moderation = await moderateStoreContent({
      texts: [
        renameTo,
        message,
        descriptionChanged ? listing.description : undefined,
        tagsChanged && listing.tags.length ? listing.tags.join(" ") : undefined,
      ],
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
          metadata: {
            categories: moderation.categories,
            name: renameTo ?? scene.name,
            ...(message ? { message } : {}),
          },
          target: { sceneId: scene.id },
        });
        return jsonError("content_rejected", 422, {
          categories: moderation.categories,
        });
      }
      return jsonError("moderation_unavailable", 503);
    }
  }

  // The zip carries the listing too (an exported scene should say what its
  // page says), and the manifest name follows the listing's — see the rename
  // note above. Never the reverse: the row is what the owner sees and what
  // publishing resolves names against.
  const listingName = renameTo ?? scene.name;
  const manifestName = extractManifestNameFromZip(latestZip);
  const rebuilt = rebuildZip(latestZip, {
    manifest: {
      category: listing.category,
      description: listing.description,
      frameosVersion: listing.frameosVersion,
      ...(manifestName === listingName ? {} : { name: listingName }),
      tags: listing.tags,
    },
    scenesJson: JSON.stringify(scenes, null, 2),
  });
  if (!rebuilt) {
    return jsonError("invalid_scene_zip", 500);
  }
  if (rebuilt.length > maxSceneZipBytes) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }
  const validation = validateSceneZip(rebuilt);
  if (!validation.ok) {
    return jsonError(validation.error, 400);
  }
  // The zip's one cover is the set's position 0, so a download shows what
  // the page shows.
  const aligned = await alignZipCover(rebuilt, validation.value, images);
  if ("error" in aligned) {
    return jsonError(
      aligned.error,
      aligned.error === "scene_too_large" ? 413 : aligned.error === "image_not_found" ? 404 : 500,
    );
  }
  const { content, validated } = aligned;

  // Every save appends an immutable version; without this check the editor
  // was the one write path that ignored the account byte quota entirely.
  // Newly linked images count too. Public scenes are free (usage.ts).
  if (scene.visibility !== "public") {
    const previousShas = new Set(previousImages.map((image) => image.sha256));
    const newImageBytes = images
      .filter((image) => !previousShas.has(image.sha256))
      .reduce((sum, image) => sum + image.sizeBytes, 0);
    const [privateBytes, { privateSceneBytes: maxBytes }] = await Promise.all([
      privateSceneBytesForAccount(db, session.accountId!),
      accountLimits(db, session.accountId!),
    ]);
    if (privateBytes + content.length + newImageBytes > maxBytes) {
      return jsonError("storage_quota_exceeded", 403, {
        max_bytes: maxBytes,
        private_bytes: Math.round(privateBytes),
      });
    }
  }

  const nextVersion = scene.latestVersion + 1;
  const written = await writeSceneVersion(db, {
    content,
    images,
    listing,
    message,
    // The slug is deliberately NOT re-derived: it is the URL people have
    // shared, pasted into a frame's Templates panel and bookmarked.
    ...(renameTo ? { rowChanges: { name: renameTo } } : {}),
    sceneId: scene.id,
    validated,
    version: nextVersion,
  });
  if ("error" in written) {
    return jsonError(written.error, 500);
  }
  const { updated } = written;

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "store.scene_content_edited",
    metadata: {
      ...(message ? { message } : {}),
      ...(imagesChanged ? { imageCount: images.length, imagesChanged: true } : {}),
      ...(listingChanged
        ? { listingChanged: Object.keys(listingInput?.changes ?? {}).sort() }
        : {}),
      name: renameTo ?? scene.name,
      ...(renameTo ? { renamedFrom: scene.name } : {}),
      sceneCount: validated.sceneCount,
      ...(body.scenes !== undefined ? { scenesChanged: true } : {}),
      version: nextVersion,
    },
    target: { sceneId: scene.id },
  });

  return NextResponse.json({
    scene: { ...sceneSummary(updated), message, version: nextVersion },
    status: "published",
  });
}
