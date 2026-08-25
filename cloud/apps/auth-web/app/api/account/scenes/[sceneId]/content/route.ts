import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  storeSceneVersions,
  storeScenes,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import {
  blobNamespaces,
  readBlob,
  storeBlob,
} from "../../../../../../src/lib/blobs";
import { jsonError, readJsonObject } from "../../../../../../src/lib/device-flow";
import { moderateStoreContent } from "../../../../../../src/lib/moderation";
import { identityRateLimitResponse } from "../../../../../../src/lib/rate-limit";
import {
  extractScenesFromZip,
  sceneDisplayName,
} from "../../../../../../src/lib/scene-title";
import {
  maxSceneEditsPer15Minutes,
  maxSceneEditsPerHour,
  maxSceneZipBytes,
  normalizeVersionMessage,
  rebuildZipWithScenes,
  sceneSummary,
  validateSceneZip,
} from "../../../../../../src/lib/store";
import { loadOwnedScene } from "../../../../../../src/lib/store-owner";
import {
  maxPrivateSceneBytesPerAccount,
  privateSceneBytesForAccount,
} from "../../../../../../src/lib/usage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// Owner web editing of a scene's contents: replaces scenes.json in the
// latest version's zip and publishes the result as a new immutable version
// (versions never mutate — decision 2). The manifest and preview image carry
// over unchanged, so no moderation re-check is needed; risk flags are
// recomputed from the new scenes.
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

  const body = await readJsonObject(request);
  if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
    return jsonError("invalid_scenes", 400);
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
  const previousSceneName = sceneDisplayName(
    extractScenesFromZip(Buffer.from(latestContent)),
  );
  const nextSceneName = sceneDisplayName(body.scenes);
  let renameTo: string | undefined;
  if (
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

  // Names and version messages show on public pages, so they pass the same
  // gate publishing and description edits do — one call for both, and none
  // at all for the usual save that carries neither.
  if (renameTo || message) {
    const moderation = await moderateStoreContent({
      texts: [renameTo, message],
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

  const content = rebuildZipWithScenes(
    Buffer.from(latestContent),
    JSON.stringify(body.scenes, null, 2),
    renameTo,
  );
  if (!content) {
    return jsonError("invalid_scene_zip", 500);
  }
  if (content.length > maxSceneZipBytes) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }
  // Every save appends an immutable version; without this check the editor
  // was the one write path that ignored the account byte quota entirely.
  // Public scenes are free (usage.ts).
  if (scene.visibility !== "public") {
    const privateBytes = await privateSceneBytesForAccount(db, session.accountId!);
    if (privateBytes + content.length > maxPrivateSceneBytesPerAccount) {
      return jsonError("storage_quota_exceeded", 403, {
        max_bytes: maxPrivateSceneBytesPerAccount,
        private_bytes: Math.round(privateBytes),
      });
    }
  }

  const validated = validateSceneZip(content);
  if (!validated.ok) {
    return jsonError(validated.error, 400);
  }

  const nextVersion = scene.latestVersion + 1;
  const stored = await storeBlob(
    blobNamespaces.sceneVersion,
    content,
    "application/zip",
    { extension: "zip" },
  );
  await db.insert(storeSceneVersions).values({
    contentType: "application/zip",
    frameosVersion: validated.value.frameosVersion ?? latest.frameosVersion,
    message,
    objectKey: stored.objectKey,
    riskFlags: validated.value.riskFlags,
    sceneId: scene.id,
    sha256: stored.sha256,
    sizeBytes: stored.sizeBytes,
    version: nextVersion,
  });
  // Every editor save keeps its version; see the note in store-publish.ts on
  // retiring the 20-version prune.

  const [updated] = await db
    .update(storeScenes)
    .set({
      latestVersion: nextVersion,
      // The slug is deliberately NOT re-derived: it is the URL people have
      // shared, pasted into a frame's Templates panel and bookmarked.
      ...(renameTo ? { name: renameTo } : {}),
      riskFlags: validated.value.riskFlags,
      updatedAt: new Date(),
    })
    .where(eq(storeScenes.id, scene.id))
    .returning();
  if (!updated) {
    return jsonError("scene_update_failed", 500);
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "store.scene_content_edited",
    metadata: {
      ...(message ? { message } : {}),
      name: renameTo ?? scene.name,
      ...(renameTo ? { renamedFrom: scene.name } : {}),
      sceneCount: validated.value.sceneCount,
      version: nextVersion,
    },
    target: { sceneId: scene.id },
  });

  return NextResponse.json({
    scene: { ...sceneSummary(updated), message, version: nextVersion },
    status: "published",
  });
}
