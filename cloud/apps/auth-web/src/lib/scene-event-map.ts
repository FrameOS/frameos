// The event map of an installed scene (docs/events.md, "Event map").
//
// A frame has the keys it has and a store scene listens for the ones its
// author had; the owner remaps them per INSTALLED scene. The map is not scene
// content — store versions are immutable zips and an update must keep it —
// so it lives on the assignment row (`event_maps`, migration 0067), keyed by
// the runtime scene id inside the version's scenes.json (a pack has several),
// and buildScenesPayloadForFrame writes each list onto its scene as `eventMap`
// beside `nodes`: the shape the device reads (frameos/src/frameos/event_map.nim).
//
// A rule: `{event, match?, as}` — an event of that name whose payload carries
// every `match` value is delivered with `as` written over its payload. The
// shape is validated here on the way in; what a rule MEANS is the runtime's
// business and the dispatcher corpus (docs/event-fixtures.json) pins it.

export type EventMapValue = string | number | boolean;

export type EventMapRule = {
  event: string;
  match?: Record<string, EventMapValue>;
  as: Record<string, EventMapValue>;
};

/** Runtime scene id → that scene's rules. */
export type SceneEventMaps = Record<string, EventMapRule[]>;

// Bounds that stop a body from carrying a novel; a real map has a handful of
// rules with two or three fields each.
export const maxEventMapScenes = 20;
export const maxEventMapRules = 64;
export const maxEventMapFields = 16;
const maxEventName = 63; // customEvents.maxNameLength
const maxFieldName = 64;
const maxFieldValue = 256;

function readValues(value: unknown): Record<string, EventMapValue> | false {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxEventMapFields) {
    return false;
  }
  const out: Record<string, EventMapValue> = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || key.length > maxFieldName) {
      return false;
    }
    if (typeof raw === "string") {
      if (raw.length > maxFieldValue) {
        return false;
      }
      out[key] = raw;
    } else if (typeof raw === "number") {
      if (!Number.isFinite(raw)) {
        return false;
      }
      out[key] = raw;
    } else if (typeof raw === "boolean") {
      out[key] = raw;
    } else {
      return false;
    }
  }
  return out;
}

/** One rule, normalized, or false when it is not one. */
export function readEventMapRule(value: unknown): EventMapRule | false {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rule = value as Record<string, unknown>;
  const event = typeof rule.event === "string" ? rule.event.trim() : "";
  if (!event || event.length > maxEventName) {
    return false;
  }
  const as = readValues(rule.as);
  if (as === false) {
    return false;
  }
  const match = rule.match === undefined || rule.match === null ? {} : readValues(rule.match);
  if (match === false) {
    return false;
  }
  return { event, ...(Object.keys(match).length > 0 ? { match } : {}), as };
}

/** A scene's rule list, normalized, or false when it is not one. */
export function readEventMapRules(value: unknown): EventMapRule[] | false {
  if (!Array.isArray(value) || value.length > maxEventMapRules) {
    return false;
  }
  const rules: EventMapRule[] = [];
  for (const item of value) {
    const rule = readEventMapRule(item);
    if (rule === false) {
      return false;
    }
    rules.push(rule);
  }
  return rules;
}

/**
 * The optional `event_maps` of one scene entry on the wire: undefined when
 * absent (keep what the assignment has), the normalized maps when well-formed
 * (an empty object, or one whose lists are all empty, is null: no map), false
 * when malformed. Keys are runtime scene ids.
 */
export function readEventMapsField(value: unknown): SceneEventMaps | null | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxEventMapScenes) {
    return false;
  }
  const maps: SceneEventMaps = {};
  for (const [sceneId, rules] of entries) {
    if (!sceneId || sceneId.length > 256) {
      return false;
    }
    const read = readEventMapRules(rules);
    if (read === false) {
      return false;
    }
    if (read.length > 0) {
      maps[sceneId] = read;
    }
  }
  return Object.keys(maps).length > 0 ? maps : null;
}

/** The column's value as maps, tolerating whatever an older row holds. */
export function sceneEventMapsOf(stored: unknown): SceneEventMaps | null {
  const read = readEventMapsField(stored);
  return read === false || read === undefined ? null : read;
}

/**
 * Each scene of one assigned version with its map written on as `eventMap`
 * — by runtime id, or, for a version with exactly one scene and a column
 * with exactly one list, that list (a republish that re-ided its only scene
 * keeps the owner's map). A scene with no map is returned untouched, and a
 * stale `eventMap` inside the published content never travels: the map is
 * the installed copy's alone.
 */
export function withSceneEventMaps<T>(scenes: readonly T[], maps: SceneEventMaps | null): T[] {
  return scenes.map((scene) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      return scene;
    }
    const { eventMap: _published, ...rest } = scene as T & { eventMap?: unknown };
    const id = (scene as { id?: unknown }).id;
    const lists = maps ? Object.values(maps) : [];
    const rules =
      (maps && typeof id === "string" ? maps[id] : undefined) ??
      (scenes.length === 1 && lists.length === 1 ? lists[0] : undefined);
    return (rules && rules.length > 0 ? { ...rest, eventMap: rules } : rest) as T;
  });
}
