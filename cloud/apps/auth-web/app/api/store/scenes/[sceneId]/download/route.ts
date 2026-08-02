import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { storeScenes, storeSceneVersions } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  canAccessPrivateScene,
  shareTokenGrantsAccess,
} from "../../../../../../src/lib/store-auth";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// Download a scene's template zip. Public scenes need no auth (this URL is
// what repository.json points frameos installs at). Private scenes are
// downloadable only by their owner's web session. Pulled scenes answer 410
// everywhere — the moderation kill switch.
export async function GET(request: NextRequest, context: RouteContext) {
  const limited = await rateLimitResponse(request, "store:download", {
    limit: 600,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
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
    .select({
      accountId: storeScenes.accountId,
      id: storeScenes.id,
      shareToken: storeScenes.shareToken,
      slug: storeScenes.slug,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId))
    .limit(1);

  if (!scene) {
    return jsonError("scene_not_found", 404);
  }
  if (scene.status === "pulled") {
    return jsonError("scene_pulled", 410);
  }
  if (scene.visibility !== "public") {
    const shared = shareTokenGrantsAccess(
      scene.shareToken,
      request.nextUrl.searchParams.get("share"),
    );
    if (
      !shared &&
      !(await canAccessPrivateScene(db, request.headers.get("authorization"), scene.accountId))
    ) {
      return jsonError("scene_not_found", 404);
    }
  }

  const requestedVersion = versionParam(request);
  if (requestedVersion === null) {
    return jsonError("invalid_version", 400);
  }

  // Default to the newest non-yanked version; an explicitly requested
  // version is served even when yanked (yank hides, it does not break).
  const [version] = await db
    .select()
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, scene.id),
        requestedVersion
          ? eq(storeSceneVersions.version, requestedVersion)
          : isNull(storeSceneVersions.yankedAt),
      ),
    )
    .orderBy(desc(storeSceneVersions.version))
    .limit(1);

  if (!version) {
    return jsonError("version_not_found", 404);
  }

  // Fire-and-forget download counting; a lost increment is fine.
  void db
    .update(storeScenes)
    .set({ downloadCount: sql`${storeScenes.downloadCount} + 1` })
    .where(eq(storeScenes.id, scene.id))
    .then(
      () => undefined,
      () => undefined,
    );

  return new NextResponse(Buffer.from(version.content), {
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${scene.slug}-v${version.version}.zip"`,
      "content-length": String(version.content.length),
      "content-type": version.contentType,
      "x-scene-sha256": version.sha256,
      "x-scene-version": String(version.version),
    },
  });
}

function versionParam(request: NextRequest): number | undefined | null {
  const raw = request.nextUrl.searchParams.get("version");
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
