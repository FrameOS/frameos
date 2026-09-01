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
  frames,
  frameSceneAssignments,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { readBlob } from "./blobs";
import { cachedAssetFile, sceneSnapshotAssetPath } from "./frame-asset-cache";
import { imageSetForVersion } from "./store-images";
import {
  extractScenesJson,
  frameForAccount,
  storeFrameAssetFile,
  type FramesDatabase,
} from "./frames";
import {
  detectImageContentType,
  isProvablyFullyTransparentImage,
  maxPreviewImageBytes,
} from "./store";

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
    .select({
      content: storeSceneVersions.content,
      objectKey: storeSceneVersions.objectKey,
    })
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, sceneId),
        eq(storeSceneVersions.version, version),
      ),
    )
    .limit(1);
  const content = await readBlob(row);
  const ids = content ? runtimeIdsFromZip(content) : new Set<string>();
  rememberRuntimeIds(key, ids);
  return ids;
}

// The per-scene deploy ledger frames.deployed_scene_state holds
// ({storeSceneId: {version, checksum}}, promoted from assigned_scene_state
// by the hub when the device acks the set checksum). The version the device
// RECEIVED for a store scene, when the ledger knows it; undefined on frames
// that predate the columns or never acked a push.
function deployedVersionFor(
  deployedSceneState: unknown,
  storeSceneId: string,
): number | undefined {
  if (
    !deployedSceneState ||
    typeof deployedSceneState !== "object" ||
    Array.isArray(deployedSceneState)
  ) {
    return undefined;
  }
  const ledger = deployedSceneState as Record<string, unknown>;
  const lowered = storeSceneId.toLowerCase();
  const key =
    storeSceneId in ledger
      ? storeSceneId
      : Object.keys(ledger).find((id) => id.toLowerCase() === lowered);
  const entry = key === undefined ? undefined : ledger[key];
  const version = (entry as { version?: unknown } | null)?.version;
  return typeof version === "number" && Number.isInteger(version) && version > 0
    ? version
    : undefined;
}

// The opposite direction: the ids a device knows for assigned store scenes.
// The workspace lists a cloud frame's scenes by store scene uuid (the
// assignment), but the payload set_scenes ships is a version's scenes.json,
// whose scenes carry their own ids — so "activate scene" sent the store uuid
// and the device answered `scenes:select … apply-failed` (seen on an E1004;
// only "preview on frame", which ships the payload with its own id, worked).
//
// Which version's ids: the one the deploy ledger says the device ACKED
// (deployed_scene_state), because that is the scenes.json it actually holds;
// a newer assignment it has not received yet would name ids it cannot
// select. Only when the ledger has nothing for the scene (pre-ledger frames,
// never acked) does the pinned/latest non-yanked version stand in.
//
// One assignments + ledger read for the whole batch (a schedule names many
// scenes). Each entry maps to the first runtime id of that version when the
// id is an assigned store scene, otherwise to itself unchanged (presumably
// already a runtime id, or unknown — the device will say).
export async function deviceSceneIdsForFrame(
  db: FramesDatabase,
  frameId: string,
  sceneIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(sceneIds.filter((id) => id.length > 0))];
  if (wanted.length === 0) {
    return out;
  }
  const [assignments, [frame]] = await Promise.all([
    db
      .select({
        sceneId: frameSceneAssignments.sceneId,
        sceneVersion: frameSceneAssignments.sceneVersion,
      })
      .from(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frameId)),
    db
      .select({ deployedSceneState: frames.deployedSceneState })
      .from(frames)
      .where(eq(frames.id, frameId))
      .limit(1),
  ]);
  for (const sceneId of wanted) {
    const lowered = sceneId.toLowerCase();
    const assignment = assignments.find(
      (row) => row.sceneId.toLowerCase() === lowered,
    );
    if (!assignment) {
      out.set(sceneId, sceneId);
      continue;
    }
    const version =
      deployedVersionFor(frame?.deployedSceneState, assignment.sceneId) ??
      (await pinnedVersionNumber(
        db,
        assignment.sceneId,
        assignment.sceneVersion,
      ));
    if (version === undefined) {
      out.set(sceneId, sceneId);
      continue;
    }
    const ids = await runtimeIdsForVersion(db, assignment.sceneId, version);
    const [runtimeId] = ids;
    out.set(sceneId, runtimeId ?? sceneId);
  }
  return out;
}

// Single-id form of deviceSceneIdsForFrame (the setCurrentScene event).
export async function deviceSceneIdForFrame(
  db: FramesDatabase,
  frameId: string,
  sceneId: string,
): Promise<string> {
  if (!sceneId) {
    return sceneId;
  }
  const ids = await deviceSceneIdsForFrame(db, frameId, [sceneId]);
  return ids.get(sceneId) ?? sceneId;
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

// The cover image for a store scene: position 0 of its latest version's
// image set, or the next image along when that one is provably transparent
// (legacy bytes uploaded before the publish-time check existed). Pulled
// scenes serve nothing — the moderation kill switch hides their bytes
// everywhere.
export async function storeSceneCoverImage(
  db: FramesDatabase,
  storeSceneId: string,
): Promise<{ content: Buffer; contentType: string } | undefined> {
  const [scene] = await db
    .select({ status: storeScenes.status })
    .from(storeScenes)
    .where(eq(storeScenes.id, storeSceneId))
    .limit(1);
  if (!scene || scene.status !== "active") {
    return undefined;
  }
  for (const image of await imageSetForVersion(db, storeSceneId, null)) {
    const content = await readBlob(image);
    if (!content) {
      continue;
    }
    if (isTransparentCover(`image:${image.sha256}`, content)) {
      continue;
    }
    return {
      content,
      // Sniffed rather than trusted: see the note in the public image route.
      contentType: detectImageContentType(content) ?? image.contentType,
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

// The reverse direction of copySceneCoversIntoFrameCache: when the workspace
// save turns a frame's runtime scene into a NEW private cloud scene, the
// frame's snapshot cache is the only place its cover exists — the image.jpg
// an uploaded zip left there (POST scene_images), or the device's own
// render. Returns bytes fit for the zip's image.jpg, or undefined when there
// is nothing usable: a foreign or unknown frame, an empty cache, bytes that
// are not a raster, too large, or provably transparent (any of which would
// make validateSceneZip refuse the whole publish).
export async function framePreviewForNewScene(
  db: Parameters<typeof frameForAccount>[0],
  accountId: string,
  frameId: unknown,
  sceneId: unknown,
): Promise<Buffer | undefined> {
  if (typeof frameId !== "string" || typeof sceneId !== "string" || !sceneId) {
    return undefined;
  }
  const frame = await frameForAccount(db, accountId, frameId);
  if (!frame) {
    return undefined;
  }
  const row = await cachedAssetFile(
    db,
    frame.id,
    sceneSnapshotAssetPath(sceneId),
    false,
  );
  const content = await readBlob(row);
  if (
    !content ||
    content.length === 0 ||
    content.length > maxPreviewImageBytes ||
    !detectImageContentType(content) ||
    isTransparentCover(`frame:${frame.id}:${sceneId}`, content)
  ) {
    return undefined;
  }
  return content;
}

export function resetSceneImageCacheForTests() {
  runtimeIdCache.clear();
  transparencyVerdictCache.clear();
}
