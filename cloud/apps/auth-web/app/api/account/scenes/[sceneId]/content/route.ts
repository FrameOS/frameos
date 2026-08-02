import { and, desc, eq, isNull, lt } from "drizzle-orm";
import {
  storeSceneVersions,
  storeScenes,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { sha256Hex } from "../../../../../../src/lib/backups";
import { jsonError, readJsonObject } from "../../../../../../src/lib/device-flow";
import { identityRateLimitResponse } from "../../../../../../src/lib/rate-limit";
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
  const accountLimited = identityRateLimitResponse(
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

  const content = rebuildZipWithScenes(
    Buffer.from(latest.content),
    JSON.stringify(body.scenes, null, 2),
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
      name: scene.name,
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
