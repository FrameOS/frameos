import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  storeSceneVersionImages,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { getScenesBaseUrl } from "../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { readBlob } from "../../../../../src/lib/blobs";
import {
  listingForVersion,
  moderateListingChanges,
} from "../../../../../src/lib/store-listing";
import { imageSetForVersion } from "../../../../../src/lib/store-images";
import { sceneSummary, sceneVisibilities } from "../../../../../src/lib/store";
import { loadOwnedScene } from "../../../../../src/lib/store-owner";
import {
  accountLimits,
  privateSceneBytesForAccount,
  sceneBytesTotal,
} from "../../../../../src/lib/usage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// One owned scene with what the /s/[slug] page shows its owner: the
// summary, every version (yanked ones included — yank hides from "latest",
// it does not delete) with the listing and image set it recorded, and the
// latest version's images in full. The content itself stays at
// GET /api/store/scenes/{id}/scenes.json?version=N.
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
  const versions = await db
    .select({
      category: storeSceneVersions.category,
      createdAt: storeSceneVersions.createdAt,
      description: storeSceneVersions.description,
      frameosVersion: storeSceneVersions.frameosVersion,
      id: storeSceneVersions.id,
      listingRecorded: storeSceneVersions.listingRecorded,
      message: storeSceneVersions.message,
      riskFlags: storeSceneVersions.riskFlags,
      sha256: storeSceneVersions.sha256,
      sizeBytes: storeSceneVersions.sizeBytes,
      tags: storeSceneVersions.tags,
      version: storeSceneVersions.version,
      yankedAt: storeSceneVersions.yankedAt,
    })
    .from(storeSceneVersions)
    .where(eq(storeSceneVersions.sceneId, scene.id))
    .orderBy(desc(storeSceneVersions.version));
  const [images, links] = await Promise.all([
    imageSetForVersion(db, scene.id, null),
    versions.length
      ? db
          .select({
            imageSha256: storeSceneVersionImages.imageSha256,
            versionId: storeSceneVersionImages.versionId,
          })
          .from(storeSceneVersionImages)
          .where(
            inArray(
              storeSceneVersionImages.versionId,
              versions.map((version) => version.id),
            ),
          )
          .orderBy(asc(storeSceneVersionImages.position))
      : [],
  ]);
  const linksByVersion = new Map<string, string[]>();
  for (const link of links) {
    const list = linksByVersion.get(link.versionId) ?? [];
    list.push(link.imageSha256);
    linksByVersion.set(link.versionId, list);
  }
  const latestImages = images.map((image) => image.sha256);
  return NextResponse.json(
    {
      images: images.map((image) => ({
        content_type: image.contentType,
        height: image.height,
        sha256: image.sha256,
        size_bytes: image.sizeBytes,
        url: `/api/store/scenes/${scene.id}/images/${image.sha256}`,
        width: image.width,
      })),
      scene: {
        ...sceneSummary(scene),
        has_preview: images.length > 0,
        preview_url:
          images.length > 0
            ? `/api/store/scenes/${scene.id}/image?v=${scene.latestVersion}`
            : null,
        pulled_reason: scene.pulledReason,
        share_url: scene.shareToken
          ? `${getScenesBaseUrl()}/s/${scene.slug}?share=${scene.shareToken}`
          : null,
        url: `${getScenesBaseUrl()}/s/${scene.slug}`,
      },
      versions: versions.map((version) => {
        const listing = listingForVersion(version, scene);
        return {
          created_at: version.createdAt.toISOString(),
          frameos_version: listing.frameosVersion,
          // A version published before image sets were recorded shows the
          // latest set, as imageSetForVersion does.
          images: version.listingRecorded
            ? (linksByVersion.get(version.id) ?? [])
            : latestImages,
          listing: {
            category: listing.category,
            description: listing.description,
            frameos_version: listing.frameosVersion,
            tags: listing.tags,
          },
          message: version.message,
          risk_flags: version.riskFlags,
          sha256: version.sha256,
          size_bytes: version.sizeBytes,
          version: version.version,
          yanked: version.yankedAt !== null,
        };
      }),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// Owner management of a scene from the web that is NOT part of a version:
// the visibility toggle, and delete. The listing (description, tags,
// category, minimum FrameOS version) and the images are published with a
// version — POST …/content. Moderation state (status/featured) is
// admin-only and lives under /api/admin/scenes.
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { db, errorResponse, scene, session } = await loadOwnedScene(
    request,
    context,
  );
  if (!scene || !db || !session) {
    return errorResponse;
  }

  const body = await readJsonObject(request);
  const visibility = parseOptionalString(body.visibility);
  if (visibility === undefined) {
    return jsonError("nothing_to_update", 400);
  }
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
    const { privateSceneBytes: maxBytes } = await accountLimits(
      db,
      session.accountId!,
    );
    if (privateBytes + flippedBytes > maxBytes) {
      return jsonError("storage_quota_exceeded", 403, {
        max_bytes: maxBytes,
        private_bytes: Math.round(privateBytes),
        scene_bytes: Math.round(flippedBytes),
      });
    }
  }

  // Flipping a scene public re-checks the whole listing (name +
  // description + cover) through the same gate publishing uses.
  const makingPublic = visibility === "public" && scene.visibility !== "public";
  if (makingPublic) {
    const [cover] = await imageSetForVersion(db, scene.id, null);
    const coverBytes = cover ? await readBlob(cover) : undefined;
    const moderation = await moderateListingChanges({
      changes: {},
      makingPublic,
      scene: {
        description: scene.description,
        name: scene.name,
        previewImage: coverBytes ?? null,
        previewImageType: cover?.contentType ?? null,
      },
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

  const [updated] = await db
    .update(storeScenes)
    .set({ updatedAt: new Date(), visibility })
    .where(eq(storeScenes.id, scene.id))
    .returning();
  if (!updated) {
    return jsonError("scene_update_failed", 500);
  }

  if (visibility !== scene.visibility) {
    await recordAuditEvent(db, {
      accountId: session.accountId,
      actor: {
        accountId: session.accountId,
        providerSubject: session.providerSubject,
      },
      eventType: "store.visibility_changed",
      metadata: { name: scene.name, visibility },
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
