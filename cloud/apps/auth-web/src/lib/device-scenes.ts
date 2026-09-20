// What a frame was already running when it joined the cloud.
//
// A frame that flips "Manage this frame from FrameOS Cloud" on while it runs
// scenes of its own used to arrive empty: the hub protocol had no device →
// cloud scene path, so the frame kept rendering what it had and the workspace
// listed nothing. The `scenes_get` verb (docs/cloud-frames.md) is that path;
// this module is the provider's bookkeeping around it:
//
//   - when the hub should ask (shouldRequestDeviceScenes),
//   - parsing and storing the reply (storeFrameDeviceScenes),
//   - the summary the workspace's import banner reads (deviceScenesSummary),
//   - the content digest the importer dedupes on (deviceSceneContentSha256).
//
// Next-free on purpose: the frame hub imports it. The importer itself
// (device-scene-import.ts) publishes store scenes — moderation, object
// storage, quotas — and lives on the auth-web side only.

import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  createDb,
  frameDeviceScenes,
  frameSceneAssignments,
} from "@frameos-cloud/db";

type Database = ReturnType<typeof createDb>;
export type FrameDeviceScenesRow = typeof frameDeviceScenes.$inferSelect;

// The reply rides the asset_chunk stream, so the hub's per-file cap (8 MiB)
// already bounds it; this is the same number, stated where the importer can
// see it.
export const maxDeviceScenesBytes = 8 * 1024 * 1024;
// A frame holds at most 20 assigned scenes; a device with far more than that
// is reporting something other than a scene list.
export const maxDeviceScenes = 200;
// The banner's own list — names only, never scene bodies.
const maxSummaryScenes = 50;
const maxSceneIdChars = 256;
const maxSceneNameChars = 128;

export type DeviceScene = Record<string, unknown> & { id: string };

export type DeviceScenesDocument = {
  activeScene: string | undefined;
  scenes: DeviceScene[];
  skippedCompiled: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The display name of one device scene: its own, else its id. */
export function deviceSceneName(scene: DeviceScene): string {
  const name = typeof scene.name === "string" ? scene.name.trim() : "";
  return (name || scene.id).slice(0, maxSceneNameChars);
}

/**
 * Parse a `scenes_get` reply. Everything in it is device-supplied: scenes
 * without a usable id, compiled scenes and duplicates of an id are dropped
 * here, so nothing downstream has to ask again. Undefined when the bytes are
 * not the documented shape at all.
 */
export function parseDeviceScenesDocument(
  content: Buffer,
): DeviceScenesDocument | undefined {
  if (content.length === 0 || content.length > maxDeviceScenesBytes) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.scenes)) {
    return undefined;
  }
  const scenes: DeviceScene[] = [];
  const seen = new Set<string>();
  let skippedCompiled =
    typeof parsed.skipped_compiled === "number" &&
    Number.isInteger(parsed.skipped_compiled) &&
    parsed.skipped_compiled > 0
      ? Math.min(parsed.skipped_compiled, maxDeviceScenes)
      : 0;
  for (const entry of parsed.scenes) {
    if (scenes.length >= maxDeviceScenes) {
      break;
    }
    if (!isRecord(entry) || typeof entry.id !== "string") {
      continue;
    }
    const id = entry.id;
    if (id.length === 0 || id.length > maxSceneIdChars || seen.has(id)) {
      continue;
    }
    // The device filters these itself; a provider believes nobody.
    if (isRecord(entry.settings) && entry.settings.execution === "compiled") {
      skippedCompiled += 1;
      continue;
    }
    seen.add(id);
    scenes.push(entry as DeviceScene);
  }
  const activeScene =
    typeof parsed.active_scene === "string" &&
    parsed.active_scene.length > 0 &&
    parsed.active_scene.length <= maxSceneIdChars
      ? parsed.active_scene
      : undefined;
  return { activeScene, scenes, skippedCompiled };
}

// Keys sorted at every depth, so two serializations of one scene digest the
// same whatever order the device, the editor or Postgres put them in.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A scene without its `origin` stamp — the provenance the cloud stamps on
 *  every scene it serves, which the original on the device never carried. */
export function withoutDeviceSceneOrigin<T extends Record<string, unknown>>(
  scene: T,
): T {
  const { origin: _origin, ...rest } = scene;
  return rest as T;
}

/** The dedupe key: sha256 of the scene's canonical JSON, `origin` excluded,
 *  so the copy the cloud pushed back still matches the one it was made from. */
export function deviceSceneContentSha256(scene: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson(withoutDeviceSceneOrigin(scene)))
    .digest("hex");
}

/**
 * Should the hub ask this frame for its scenes? Only a frame that SAYS it
 * holds some (`scene_count` in its hello — firmware from before the verb
 * sends none, and neither does the ESP32 profile, so neither is ever asked),
 * that the cloud has assigned nothing to, and whose owner has not already
 * imported or dismissed what it holds. While the answer is still waiting for
 * the owner it is asked for again on every connect, so an import never works
 * from a snapshot older than the frame's last session.
 */
export async function shouldRequestDeviceScenes(
  db: Database,
  frame: { assignedChecksum: string | null; id: string },
  hello: Record<string, unknown>,
): Promise<boolean> {
  const count = hello.scene_count;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
    return false;
  }
  if (frame.assignedChecksum) {
    return false;
  }
  const [assignment] = await db
    .select({ id: frameSceneAssignments.id })
    .from(frameSceneAssignments)
    .where(eq(frameSceneAssignments.frameId, frame.id))
    .limit(1);
  if (assignment) {
    return false;
  }
  const [row] = await db
    .select({ status: frameDeviceScenes.status })
    .from(frameDeviceScenes)
    .where(eq(frameDeviceScenes.frameId, frame.id))
    .limit(1);
  return !row || row.status === "ready";
}

/**
 * Store a `scenes_get` reply as the frame's snapshot. Returns the parsed
 * document, or undefined when the reply was unusable (nothing is stored). A
 * reply with no importable scene clears a waiting snapshot instead of leaving
 * a banner that offers nothing.
 */
export async function storeFrameDeviceScenes(
  db: Database,
  frameId: string,
  content: Buffer,
): Promise<DeviceScenesDocument | undefined> {
  const document = parseDeviceScenesDocument(content);
  if (!document) {
    return undefined;
  }
  if (document.scenes.length === 0) {
    await db
      .delete(frameDeviceScenes)
      .where(
        sql`${frameDeviceScenes.frameId} = ${frameId} and ${frameDeviceScenes.status} = 'ready'`,
      );
    return document;
  }
  const values = {
    activeScene: document.activeScene ?? null,
    payload: content,
    receivedAt: new Date(),
    sceneCount: document.scenes.length,
    scenes: document.scenes.slice(0, maxSummaryScenes).map((scene) => ({
      id: scene.id,
      name: deviceSceneName(scene),
    })),
    sizeBytes: content.length,
    skippedCompiled: document.skippedCompiled,
  };
  await db
    .insert(frameDeviceScenes)
    .values({ frameId, ...values })
    .onConflictDoUpdate({
      // An import in flight keeps the payload it started from; a verdict the
      // owner already gave (imported / dismissed) is not reopened by a late
      // reply to a question asked before it.
      set: values,
      setWhere: sql`${frameDeviceScenes.status} = 'ready'`,
      target: frameDeviceScenes.frameId,
    });
  return document;
}

export type DeviceScenesSummary = {
  received_at: string;
  result: unknown;
  scene_count: number;
  scenes: { id: string; name: string }[];
  skipped_compiled: number;
  status: string;
};

/** What the workspace reads: enough for the banner, never a scene body. */
export function deviceScenesSummary(
  row: FrameDeviceScenesRow | undefined,
): DeviceScenesSummary | null {
  if (!row) {
    return null;
  }
  // Rebuilt field by field: whatever else a row's jsonb holds stays in it.
  const scenes = (Array.isArray(row.scenes) ? row.scenes : []).flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string"
      ? [{ id: entry.id, name: entry.name }]
      : [],
  );
  return {
    received_at: row.receivedAt.toISOString(),
    result: row.result ?? null,
    scene_count: row.sceneCount,
    scenes,
    skipped_compiled: row.skippedCompiled,
    status: row.status,
  };
}
