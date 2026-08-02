import { and, desc, eq, isNull, lt, ne, sql } from "drizzle-orm";
import {
  storeSceneVersions,
  storeScenes,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { sha256Hex } from "../../../../../../src/lib/backups";
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
  maxVersionsPerScene,
  rebuildZipWithScenes,
  sceneSummary,
  validateSceneZip,
} from "../../../../../../src/lib/store";
import { loadOwnedScene } from "../../../../../../src/lib/store-owner";

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

  const [latest] = await db
    .select({
      content: storeSceneVersions.content,
      frameosVersion: storeSceneVersions.frameosVersion,
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
    extractScenesFromZip(Buffer.from(latest.content)),
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
    // Names show on public pages, so a rename passes the same gate publishing
    // and description edits do.
    const moderation = await moderateStoreContent({ texts: [nextSceneName] });
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
            name: nextSceneName,
          },
          target: { sceneId: scene.id },
        });
        return jsonError("content_rejected", 422, {
          categories: moderation.categories,
        });
      }
      return jsonError("moderation_unavailable", 503);
    }
    renameTo = nextSceneName;
  }

  const content = rebuildZipWithScenes(
    Buffer.from(latest.content),
    JSON.stringify(body.scenes, null, 2),
    renameTo,
  );
  if (!content) {
    return jsonError("invalid_scene_zip", 500);
  }
  if (content.length > maxSceneZipBytes) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }

  const validated = validateSceneZip(content);
  if (!validated.ok) {
    return jsonError(validated.error, 400);
  }

  const nextVersion = scene.latestVersion + 1;
  await db.insert(storeSceneVersions).values({
    content,
    contentType: "application/zip",
    frameosVersion: validated.value.frameosVersion ?? latest.frameosVersion,
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
      name: renameTo ?? scene.name,
      ...(renameTo ? { renamedFrom: scene.name } : {}),
      sceneCount: validated.value.sceneCount,
      version: nextVersion,
    },
    target: { sceneId: scene.id },
  });

  return NextResponse.json({
    scene: { ...sceneSummary(updated), version: nextVersion },
    status: "published",
  });
}
