import { and, desc, eq, isNull } from "drizzle-orm";
import { unzipSync } from "fflate";
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

// The scenes.json extracted from a scene's latest template zip — what the
// in-browser live preview (frameos-wasm) executes. Same access rules as the
// zip download: public scenes are open, private ones owner-only, pulled 410.
export async function GET(request: NextRequest, context: RouteContext) {
  const limited = rateLimitResponse(request, "store:scenes-json", {
    limit: 240,
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
  const isPublic = scene.visibility === "public";
  if (
    !isPublic &&
    !shareTokenGrantsAccess(scene.shareToken, request.nextUrl.searchParams.get("share")) &&
    !(await canAccessPrivateScene(db, request.headers.get("authorization"), scene.accountId))
  ) {
    return jsonError("scene_not_found", 404);
  }

  const [version] = await db
    .select({
      content: storeSceneVersions.content,
      version: storeSceneVersions.version,
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

  if (!version) {
    return jsonError("version_not_found", 404);
  }

  const scenes = extractScenesJson(Buffer.from(version.content));
  if (!scenes) {
    return jsonError("invalid_scene_zip", 500);
  }

  return new NextResponse(scenes, {
    headers: {
      "cache-control": isPublic ? "public, max-age=300" : "no-store",
      "content-type": "application/json",
      "x-scene-version": String(version.version),
    },
  });
}

// The zip was validated at publish (validateSceneZip); this re-extract only
// inflates the one file it returns.
function extractScenesJson(content: Buffer): string | undefined {
  try {
    const files = unzipSync(new Uint8Array(content), {
      filter: (file) => /(^|\/)scenes\.json$/.test(file.name),
    });
    const path = Object.keys(files).sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    )[0];
    const bytes = path ? files[path] : undefined;
    if (!bytes) {
      return undefined;
    }
    const text = Buffer.from(bytes).toString("utf8");
    return Array.isArray(JSON.parse(text)) ? text : undefined;
  } catch {
    return undefined;
  }
}
