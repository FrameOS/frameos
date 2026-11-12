// The layout of an installed scene (docs/scene-layouts.md).
//
// A layout is a regular scene with `settings.isLayout`; which one wraps a
// given install, and with what settings, is the owner's choice for that
// install. Like the button map (scene-event-map.ts) it is not scene content:
// store versions are immutable zips and an update must keep it. So it lives
// on the assignment row (`layouts`, migration 0076), keyed by the runtime
// scene id inside the version's scenes.json (a pack has several), and
// buildScenesPayloadForFrame writes each entry onto its scene as `layout`
// beside `nodes`: the shape the device reads.

export type SceneLayoutRef = {
  sceneId: string;
  state?: Record<string, unknown>;
};

/** Runtime scene id → the layout that install wears. */
export type SceneLayouts = Record<string, SceneLayoutRef>;

// Bounds that stop a body from carrying a novel. A layout's state is a
// handful of the scene's public fields.
export const maxLayoutScenes = 20;
export const maxLayoutStateFields = 64;
export const maxLayoutStateBytes = 16 * 1024;
const maxSceneIdLength = 256;

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** One `{sceneId, state?}`, normalized, or false when it is not one. */
export function readSceneLayout(value: unknown): SceneLayoutRef | false {
  if (!plainObject(value)) {
    return false;
  }
  const sceneId = typeof value.sceneId === "string" ? value.sceneId.trim() : "";
  if (!sceneId || sceneId.length > maxSceneIdLength) {
    return false;
  }
  if (value.state === undefined || value.state === null) {
    return { sceneId };
  }
  if (!plainObject(value.state)) {
    return false;
  }
  const keys = Object.keys(value.state);
  if (keys.length > maxLayoutStateFields || keys.some((key) => !key || key.length > 64)) {
    return false;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value.state);
  } catch {
    return false;
  }
  if (encoded.length > maxLayoutStateBytes) {
    return false;
  }
  return keys.length > 0 ? { sceneId, state: JSON.parse(encoded) as Record<string, unknown> } : { sceneId };
}

/**
 * The optional `layouts` of one scene entry on the wire: undefined when absent
 * (keep what the assignment has), the normalized layouts when well-formed (an
 * empty object is null: none), false when malformed. Keys are runtime scene
 * ids.
 */
export function readLayoutsField(value: unknown): SceneLayouts | null | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!plainObject(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length > maxLayoutScenes) {
    return false;
  }
  const layouts: SceneLayouts = {};
  for (const [sceneId, entry] of entries) {
    if (!sceneId || sceneId.length > maxSceneIdLength) {
      return false;
    }
    const read = readSceneLayout(entry);
    if (read === false) {
      return false;
    }
    layouts[sceneId] = read;
  }
  return Object.keys(layouts).length > 0 ? layouts : null;
}

/** The column's value as layouts, tolerating whatever an older row holds. */
export function sceneLayoutsOf(stored: unknown): SceneLayouts | null {
  const read = readLayoutsField(stored);
  return read === false || read === undefined ? null : read;
}

/** Whether every scene of an assigned version is a layout. */
export function versionIsLayout(scenes: readonly unknown[]): boolean {
  return (
    scenes.length > 0 &&
    scenes.every(
      (scene) => plainObject(scene) && plainObject(scene.settings) && scene.settings.isLayout === true,
    )
  );
}

/**
 * Each scene of one assigned version with its layout written on as `layout`
 * — by runtime id, or, for a version with exactly one scene and a column with
 * exactly one entry, that entry (a republish that re-ided its only scene keeps
 * the owner's choice). A stale `layout` inside the published content never
 * travels: it is the installed copy's alone.
 */
export function withSceneLayouts<T>(scenes: readonly T[], layouts: SceneLayouts | null): T[] {
  return scenes.map((scene) => {
    if (!plainObject(scene)) {
      return scene;
    }
    const { layout: _published, ...rest } = scene as T & { layout?: unknown };
    const id = (scene as { id?: unknown }).id;
    const entries = layouts ? Object.values(layouts) : [];
    const layout =
      (layouts && typeof id === "string" ? layouts[id] : undefined) ??
      (scenes.length === 1 && entries.length === 1 ? entries[0] : undefined);
    return (layout ? { ...rest, layout } : rest) as T;
  });
}
