// Scene preview covers for cloud-managed frames (cloud-workspace-gaps.md
// item 2, short-term): until frames push per-scene snapshots, the cover of
// the store scene an assignment installed stands in for the scene preview.
//
// The wrinkle: the SPA asks for scene_images/{sceneId} with the RUNTIME scene
// id — the ids inside the store scene's scenes.json, which is what hydrated
// tiles carry — not the store scene uuid. The mapping lives in the published
// zips, so resolving a runtime id means walking the frame's assignments and
// peeking at each pinned version's scenes.json. Version rows are immutable,
// so the (scene, version) → runtime-ids extraction is cached in module scope
// and each zip is unpacked at most once per process.
//
// Kept out of frames.ts on purpose — that file is under concurrent edit.

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  frameSceneAssignments,
  storeSceneImages,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { extractScenesJson, type FramesDatabase } from "./frames";

// (storeSceneId, version) → runtime scene ids in that version's scenes.json.
// Bounded so a pathological fleet cannot grow it without limit; eviction is
// insertion-order FIFO, which is fine for a cache whose entries never go
// stale (versions are immutable).
const runtimeIdCache = new Map<string, ReadonlySet<string>>();
const runtimeIdCacheMaxEntries = 512;

function cacheKey(sceneId: string, version: number) {
  return `${sceneId}:${version}`;
}

function rememberRuntimeIds(key: string, ids: ReadonlySet<string>) {
  if (runtimeIdCache.size >= runtimeIdCacheMaxEntries) {
    const oldest = runtimeIdCache.keys().next().value;
    if (oldest !== undefined) {
      runtimeIdCache.delete(oldest);
    }
  }
  runtimeIdCache.set(key, ids);
}

function runtimeIdsFromZip(content: Buffer): ReadonlySet<string> {
  const extracted = extractScenesJson(content);
  const ids = new Set<string>();
  for (const scene of extracted?.scenes ?? []) {
    if (
      scene &&
      typeof scene === "object" &&
      typeof (scene as { id?: unknown }).id === "string"
    ) {
      ids.add((scene as { id: string }).id);
    }
  }
  return ids;
}

// The store_scene_versions row an assignment pins: the requested version when
// pinned, otherwise the newest non-yanked one (same rule as
// buildScenesPayloadForFrame).
async function pinnedVersionNumber(
  db: FramesDatabase,
  sceneId: string,
  sceneVersion: number | null,
) {
  const [row] = await db
    .select({ version: storeSceneVersions.version })
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, sceneId),
        isNull(storeSceneVersions.yankedAt),
        ...(sceneVersion === null
          ? []
          : [eq(storeSceneVersions.version, sceneVersion)]),
      ),
    )
    .orderBy(desc(storeSceneVersions.version))
    .limit(1);
  return row?.version;
}

async function runtimeIdsForVersion(
  db: FramesDatabase,
  sceneId: string,
  version: number,
): Promise<ReadonlySet<string>> {
  const key = cacheKey(sceneId, version);
  const cached = runtimeIdCache.get(key);
  if (cached) {
    return cached;
  }
  const [row] = await db
    .select({ content: storeSceneVersions.content })
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, sceneId),
        eq(storeSceneVersions.version, version),
      ),
    )
    .limit(1);
  const ids = row ? runtimeIdsFromZip(row.content) : new Set<string>();
  rememberRuntimeIds(key, ids);
  return ids;
}

// Resolve the store scene that owns `sceneId` on this frame. Accepts either
// a runtime scene id (matched against each assigned version's scenes.json)
// or the store scene uuid itself (matched against the assignment directly).
// Returns the store scene uuid, or undefined when nothing assigned matches.
export async function resolveStoreSceneForFrameScene(
  db: FramesDatabase,
  frameId: string,
  sceneId: string,
): Promise<string | undefined> {
  if (!sceneId) {
    return undefined;
  }
  const assignments = await db
    .select({
      sceneId: frameSceneAssignments.sceneId,
      sceneVersion: frameSceneAssignments.sceneVersion,
    })
    .from(frameSceneAssignments)
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(asc(frameSceneAssignments.position));

  // Store uuid passthrough: the id names an assigned scene outright.
  const lowered = sceneId.toLowerCase();
  for (const assignment of assignments) {
    if (assignment.sceneId.toLowerCase() === lowered) {
      return assignment.sceneId;
    }
  }

  for (const assignment of assignments) {
    const version = await pinnedVersionNumber(
      db,
      assignment.sceneId,
      assignment.sceneVersion,
    );
    if (version === undefined) {
      continue;
    }
    const ids = await runtimeIdsForVersion(db, assignment.sceneId, version);
    if (ids.has(sceneId)) {
      return assignment.sceneId;
    }
  }
  return undefined;
}

// The cover image for a store scene: the first gallery row from
// store_scene_images, falling back to the primary preview extracted at
// publish time (store_scenes.preview_image). Pulled scenes serve nothing —
// the moderation kill switch hides their bytes everywhere.
export async function storeSceneCoverImage(
  db: FramesDatabase,
  storeSceneId: string,
): Promise<{ content: Buffer; contentType: string } | undefined> {
  const [scene] = await db
    .select({
      previewImage: storeScenes.previewImage,
      previewImageType: storeScenes.previewImageType,
      status: storeScenes.status,
    })
    .from(storeScenes)
    .where(eq(storeScenes.id, storeSceneId))
    .limit(1);
  if (!scene || scene.status !== "active") {
    return undefined;
  }
  const [galleryImage] = await db
    .select({
      content: storeSceneImages.content,
      contentType: storeSceneImages.contentType,
    })
    .from(storeSceneImages)
    .where(eq(storeSceneImages.sceneId, storeSceneId))
    .orderBy(asc(storeSceneImages.position), asc(storeSceneImages.createdAt))
    .limit(1);
  if (galleryImage) {
    return {
      content: galleryImage.content,
      contentType: galleryImage.contentType || "image/jpeg",
    };
  }
  if (scene.previewImage) {
    return {
      content: scene.previewImage,
      contentType: scene.previewImageType ?? "image/jpeg",
    };
  }
  return undefined;
}

export function resetSceneImageCacheForTests() {
  runtimeIdCache.clear();
}
