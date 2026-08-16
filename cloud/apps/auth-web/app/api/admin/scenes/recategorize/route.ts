import { and, desc, eq, isNull } from "drizzle-orm";
import { unzipSync } from "fflate";
import { storeScenes, storeSceneVersions } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext } from "../../../../../src/lib/admin";
import { readBlob } from "../../../../../src/lib/blobs";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { extractAppKeywords } from "../../../../../src/lib/store";
import {
  classifyStoreScene,
  isClassificationConfigured,
} from "../../../../../src/lib/store-classify";

export const runtime = "nodejs";

// One classifier call per scene; bounded so a runaway store cannot turn this
// into an hour-long request. Rerun the action to continue where it stopped.
const maxScenesPerRun = 200;

// Superadmin backfill: run the publish-time classifier over existing scenes.
// mode "missing" (default) categorizes scenes without a category; mode "all"
// re-runs every active scene and overwrites categories. Owner tags are only
// filled in when a scene has none, never replaced.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  // Each run fans out into LLM calls, so budget it far tighter than the
  // per-scene admin actions.
  const limited = await rateLimitResponse(request, "admin:scenes-recategorize", {
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const admin = await getSuperadminContext();
  if (admin.kind !== "ok") {
    return jsonError(
      admin.kind === "forbidden" ? "forbidden" : "unauthenticated",
      admin.kind === "forbidden" ? 403 : 401,
    );
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  if (!isClassificationConfigured()) {
    return jsonError("classification_unavailable", 503);
  }

  const body = await readJsonObject(request);
  const mode = body.mode === "all" ? "all" : "missing";

  const candidates = await db
    .select({
      category: storeScenes.category,
      description: storeScenes.description,
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
      slug: storeScenes.slug,
      tags: storeScenes.tags,
    })
    .from(storeScenes)
    .where(
      and(
        eq(storeScenes.status, "active"),
        ...(mode === "missing" ? [isNull(storeScenes.category)] : []),
      ),
    )
    .orderBy(desc(storeScenes.updatedAt))
    .limit(maxScenesPerRun);

  const updated: { category: string; slug: string; tags?: string[] }[] = [];
  const failed: string[] = [];

  for (const scene of candidates) {
    // The node graph of the latest version gives the classifier its app
    // keywords; a scene without versions still classifies from name/text.
    let appKeywords: string[] = [];
    if (scene.latestVersion > 0) {
      const [latest] = await db
        .select({
          content: storeSceneVersions.content,
          objectKey: storeSceneVersions.objectKey,
        })
        .from(storeSceneVersions)
        .where(
          and(
            eq(storeSceneVersions.sceneId, scene.id),
            eq(storeSceneVersions.version, scene.latestVersion),
          ),
        )
        .limit(1);
      const latestContent = await readBlob(latest);
      if (latestContent) {
        appKeywords = appKeywordsFromZip(Buffer.from(latestContent));
      }
    }

    const classified = await classifyStoreScene({
      appKeywords,
      description: scene.description,
      existingTags: scene.tags,
      name: scene.name,
    });
    if (!classified) {
      failed.push(scene.slug);
      continue;
    }

    const fillTags = scene.tags.length === 0 && classified.tags.length > 0;
    await db
      .update(storeScenes)
      .set({
        category: classified.category,
        ...(fillTags ? { tags: classified.tags } : {}),
      })
      .where(eq(storeScenes.id, scene.id));
    updated.push({
      category: classified.category,
      slug: scene.slug,
      ...(fillTags ? { tags: classified.tags } : {}),
    });
  }

  await recordAuditEvent(db, {
    accountId: admin.accountId,
    actor: { accountId: admin.accountId, role: "superadmin" },
    eventType: "store.scenes_recategorized",
    metadata: {
      failed: failed.length,
      mode,
      scanned: candidates.length,
      updated: updated.length,
    },
  });

  return NextResponse.json({
    failed,
    scanned: candidates.length,
    status: "recategorized",
    updated,
  });
}

function appKeywordsFromZip(zipBytes: Buffer): string[] {
  try {
    const files = unzipSync(new Uint8Array(zipBytes), {
      filter: (file) => /(^|\/)scenes\.json$/.test(file.name),
    });
    const scenesPath = Object.keys(files).sort(
      (a, b) => a.split("/").length - b.split("/").length,
    )[0];
    const raw = scenesPath ? files[scenesPath] : undefined;
    if (!raw) {
      return [];
    }
    return extractAppKeywords(
      JSON.parse(Buffer.from(raw).toString("utf8")),
    );
  } catch {
    return [];
  }
}
