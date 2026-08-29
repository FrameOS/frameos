import { and, desc, eq, isNull } from "drizzle-orm";
import { unzipSync } from "fflate";
import { storeScenes, storeSceneVersions } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { readBlob } from "../../../../../../src/lib/blobs";
import {
  canAccessPrivateScene,
  canViewPulledScene,
  shareTokenGrantsAccess,
} from "../../../../../../src/lib/store-auth";
import {
  jsonError,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { withStoreSceneOrigin } from "../../../../../../src/lib/scene-origin";
import { storeRoute } from "../../../../../../src/lib/store-cache";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// The scenes.json extracted from a scene's template zip — what the
// in-browser live preview (frameos-wasm) executes. Same access and version
// rules as the zip download: public scenes are open, private ones owner-only,
// pulled 410 for everyone but the owner's and moderators' own sessions;
// `?version=N` picks a version (yanked ones included), the default is the
// newest non-yanked one.
async function handleGet(request: NextRequest, context: RouteContext) {
  const limited = await rateLimitResponse(request, "store:scenes-json", {
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
  if (
    scene.status === "pulled" &&
    !(await canViewPulledScene(scene.accountId))
  ) {
    return jsonError("scene_pulled", 410);
  }
  const isPublic = scene.visibility === "public";
  if (
    !isPublic &&
    !shareTokenGrantsAccess(
      scene.shareToken,
      request.nextUrl.searchParams.get("share"),
    ) &&
    !(await canAccessPrivateScene(
      db,
      request.headers.get("authorization"),
      scene.accountId,
    ))
  ) {
    return jsonError("scene_not_found", 404);
  }

  const requestedVersion = versionParam(request);
  if (requestedVersion === null) {
    return jsonError("invalid_version", 400);
  }

  // Default to the newest non-yanked version; an explicitly requested
  // version is served even when yanked (yank hides, it does not break).
  const [version] = await db
    .select({
      content: storeSceneVersions.content,
      objectKey: storeSceneVersions.objectKey,
      version: storeSceneVersions.version,
    })
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

  const versionContent = await readBlob(version);
  if (!versionContent) {
    return jsonError("version_not_found", 404);
  }

  const scenes = extractScenesJson(Buffer.from(versionContent));
  if (!scenes) {
    return jsonError("invalid_scene_zip", 500);
  }

  // Each scene leaves with its `origin` (store page, uuid, THIS version) —
  // the workspace hydrates cloud frames from here and keeps the stamp as the
  // record of what the frame is running. See scene-origin.ts.
  const body = JSON.stringify(
    withStoreSceneOrigin(scenes, {
      id: scene.id,
      slug: scene.slug,
      version: version.version,
    }),
  );

  return new NextResponse(body, {
    headers: {
      "cache-control": isPublic ? "public, max-age=300" : "no-store",
      "content-type": "application/json",
      "x-scene-version": String(version.version),
    },
  });
}

// Same contract as the download route: absent → default, a positive integer
// → that version, anything else → 400.
function versionParam(request: NextRequest): number | undefined | null {
  const raw = request.nextUrl.searchParams.get("version");
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// The zip was validated at publish (validateSceneZip); this re-extract only
// inflates the one file it returns.
function extractScenesJson(content: Buffer): unknown[] | undefined {
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
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Cache policy is per-response here (see storeRoute): anything this
// handler did not decide is no-store.
export const GET = storeRoute(handleGet);
