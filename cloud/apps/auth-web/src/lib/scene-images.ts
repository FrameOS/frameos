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
import { cachedAssetFile, sceneSnapshotAssetPath } from "./frame-asset-cache";
import {
  extractScenesJson,
  storeFrameAssetFile,
  type FramesDatabase,
} from "./frames";
import { isProvablyFullyTransparentImage } from "./store";

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

// Legacy rows can hold fully transparent preview bytes (screenshots captured
// before the live preview painted, uploaded before publish-time rejection
// existed). The cover resolver skips them; the verdict is cached because the
// scan inflates the PNG. Keyed by row identity + byte length so a replaced
// image gets a fresh verdict; bounded FIFO like runtimeIdCache above.
const transparencyVerdictCache = new Map<string, boolean>();
const transparencyVerdictCacheMaxEntries = 512;

function isTransparentCover(key: string, content: Buffer): boolean {
  const cacheKey = `${key}:${content.length}`;
  const cached = transparencyVerdictCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const verdict = isProvablyFullyTransparentImage(content);
  if (transparencyVerdictCache.size >= transparencyVerdictCacheMaxEntries) {
    const oldest = transparencyVerdictCache.keys().next().value;
    if (oldest !== undefined) {
      transparencyVerdictCache.delete(oldest);
    }
  }
  transparencyVerdictCache.set(cacheKey, verdict);
  return verdict;
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
  // At most maxImagesPerScene (10) rows; walk them in gallery order and skip
  // provably transparent bytes so a broken lead cannot blank every tile —
  // fall through to the next image, then to the publish-time preview.
  const galleryImages = await db
    .select({
      content: storeSceneImages.content,
      contentType: storeSceneImages.contentType,
      id: storeSceneImages.id,
    })
    .from(storeSceneImages)
    .where(eq(storeSceneImages.sceneId, storeSceneId))
    .orderBy(asc(storeSceneImages.position), asc(storeSceneImages.createdAt));
  for (const galleryImage of galleryImages) {
    if (isTransparentCover(`image:${galleryImage.id}`, galleryImage.content)) {
      continue;
    }
    return {
      content: galleryImage.content,
      contentType: galleryImage.contentType || "image/jpeg",
    };
  }
  if (
    scene.previewImage &&
    !isTransparentCover(`preview:${storeSceneId}`, scene.previewImage)
  ) {
    return {
      content: scene.previewImage,
      contentType: scene.previewImageType ?? "image/jpeg",
    };
  }
  return undefined;
}

// The explicit install-time cover copy (docs/todo.md, "a scene added from a
// template shows a blank tile"): when an assignment set is pushed, each
// installed scene's cover is written into frame_asset_files under the exact
// paths the device's own snapshots will occupy — one row per runtime scene
// id and thumb variant. The tile route then has bytes to serve from the
// first request, and the first real snapshot replaces the cover through the
// same upsert the asset_get chunk stream uses. Rows that already exist are
// left alone: a device snapshot must never lose to a cover.
export async function copySceneCoversIntoFrameCache(
  db: Parameters<typeof storeFrameAssetFile>[0],
  frameId: string,
  assignments: readonly {
    sceneId: string;
    sceneVersion: number | null;
  }[],
): Promise<void> {
  for (const assignment of assignments) {
    const cover = await storeSceneCoverImage(db, assignment.sceneId);
    if (!cover) {
      continue;
    }
    const version = await pinnedVersionNumber(
      db,
      assignment.sceneId,
      assignment.sceneVersion,
    );
    if (version === undefined) {
      continue;
    }
    const runtimeIds = await runtimeIdsForVersion(
      db,
      assignment.sceneId,
      version,
    );
    for (const runtimeId of runtimeIds) {
      const path = sceneSnapshotAssetPath(runtimeId);
      for (const thumb of [false, true]) {
        if (await cachedAssetFile(db, frameId, path, thumb)) {
          continue;
        }
        await storeFrameAssetFile(db, frameId, {
          content: cover.content,
          contentType: cover.contentType,
          path,
          thumb,
        });
      }
    }
  }
}

export function resetSceneImageCacheForTests() {
  runtimeIdCache.clear();
  transparencyVerdictCache.clear();
}
