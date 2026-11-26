// Which services each runtime scene of an install declares, and which key the
// owner bound it to (docs/service-keys.md).
//
// A store version's scenes.json is an immutable zip, so neither is read from
// it on a device pull: what each runtime scene declares is settled where the
// version is already open (buildScenesPayloadForFrame) into the assignment's
// `scene_services` column, and the owner's choice of key per runtime scene
// lives in `service_keys` (migration 0086), kept across every assignment write
// that omits it, the same rule as `event_maps` and `layouts`.

import { requiredSettingsForScenes } from "../../../../../frontend/src/sceneWorkspace/lib/preview-settings";
import {
  appServiceDefinitions,
  declaredServices,
  isServiceId,
  readSceneKeyBindings,
  serviceTitle,
  type SceneKeyBindings,
  type ServiceDefinition,
} from "../../../../../frontend/src/utils/serviceKeys";

/** Runtime scene id → the services its apps declare. */
export type SceneServices = Record<string, string[]>;
/** Runtime scene id → service → `"default"`, a credential id, or null (refused). */
export type SceneServiceKeys = Record<string, SceneKeyBindings>;

const maxSceneIdLength = 256;
const maxServiceKeyScenes = 20;
const maxServicesPerScene = 32;

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parsedConfig(raw: unknown): unknown {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Every app config.json (parsed) a scene carries: on its nodes and in its apps map.
function appConfigsOfScene(scene: Record<string, unknown>): unknown[] {
  const configs: unknown[] = [];
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const apps = plainObject(scene.apps) ? scene.apps : {};
  for (const node of nodes) {
    const data = plainObject(node) && plainObject(node.data) ? node.data : undefined;
    if (data && plainObject(data.sources)) {
      configs.push(parsedConfig(data.sources["config.json"]));
    }
  }
  for (const app of Object.values(apps)) {
    if (plainObject(app) && plainObject(app.sources)) {
      configs.push(parsedConfig(app.sources["config.json"]));
    }
  }
  return configs;
}

/**
 * What the given scenes declare, each with the title a form shows for it:
 * the registry's, else what an app defines for a service the registry does
 * not know (its config.json `services`), else the bare id.
 */
export function declaredServicesWithTitles(scenes: readonly unknown[]): { key: string; title: string }[] {
  const definitions: Record<string, ServiceDefinition> = {};
  const declared = new Set<string>();
  for (const scene of scenes) {
    if (!plainObject(scene)) {
      continue;
    }
    for (const config of appConfigsOfScene(scene)) {
      Object.assign(definitions, appServiceDefinitions(config));
    }
    for (const service of declaredServicesOfScene(scene)) {
      declared.add(service);
    }
  }
  return [...declared].sort().map((key) => ({ key, title: serviceTitle(key, definitions) }));
}

/**
 * The services one runtime scene's apps declare: an app's own config.json
 * (a JSON string under `sources`, on the node or the scene's `apps` map) is
 * authoritative when the scene carries one; a stock or retired keyword falls
 * back to the shared preview catalogue.
 */
export function declaredServicesOfScene(scene: unknown): string[] {
  if (!plainObject(scene)) {
    return [];
  }
  const found = new Set<string>();
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const apps = plainObject(scene.apps) ? scene.apps : {};
  for (const node of nodes) {
    if (!plainObject(node) || node.type !== "app") {
      continue;
    }
    const data = plainObject(node.data) ? node.data : {};
    const keyword = typeof data.keyword === "string" ? data.keyword : undefined;
    const app = keyword && plainObject(apps[keyword]) ? (apps[keyword] as Record<string, unknown>) : undefined;
    const sources = plainObject(data.sources) ? data.sources : plainObject(app?.sources) ? app.sources : undefined;
    if (sources && Object.keys(sources).length > 0) {
      for (const service of declaredServices(parsedConfig(sources["config.json"]))) {
        found.add(service);
      }
    }
  }
  // The keyword fallback (data/unsplash, …) and nothing it would not also
  // find in sources: the preview catalogue's rule for stock apps.
  for (const group of requiredSettingsForScenes([scene])) {
    if (isServiceId(group.key)) {
      found.add(group.key);
    }
  }
  return [...found].sort();
}

/**
 * Each runtime scene of one assembled version → what it declares. Every
 * runtime scene is listed, an empty list included: how many there are is
 * what lets a single-scene version keep its owner's choice across a re-id
 * (serviceKeysForRuntimeScene).
 */
export function sceneServicesOf(scenes: readonly unknown[]): SceneServices {
  const result: SceneServices = {};
  for (const scene of scenes) {
    const id = plainObject(scene) && typeof scene.id === "string" ? scene.id : undefined;
    if (!id) {
      continue;
    }
    result[id] = declaredServicesOfScene(scene);
  }
  return result;
}

/** The `scene_services` column, tolerating whatever an older row holds; undefined for a row never settled (NULL). */
export function readSceneServices(value: unknown): SceneServices | undefined {
  if (!plainObject(value)) {
    return undefined;
  }
  const result: SceneServices = {};
  for (const [sceneId, list] of Object.entries(value)) {
    if (!sceneId || sceneId.length > maxSceneIdLength || !Array.isArray(list)) {
      continue;
    }
    result[sceneId] = [...new Set(list.filter(isServiceId))].sort();
  }
  return result;
}

/**
 * The optional `service_keys` of one scene entry on the wire: undefined when
 * absent (keep what the assignment has), the normalized map when well-formed
 * (an empty one is null: none chosen), false when malformed. Keys are runtime
 * scene ids; each value maps a service to `"default"`, a credential id or null.
 */
export function readServiceKeysField(value: unknown): SceneServiceKeys | null | undefined | false {
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
  if (entries.length > maxServiceKeyScenes) {
    return false;
  }
  const result: SceneServiceKeys = {};
  for (const [sceneId, raw] of entries) {
    if (!sceneId || sceneId.length > maxSceneIdLength || !plainObject(raw)) {
      return false;
    }
    if (Object.keys(raw).length > maxServicesPerScene) {
      return false;
    }
    for (const [service, ref] of Object.entries(raw)) {
      if (!isServiceId(service)) {
        return false;
      }
      if (ref !== null && ref !== false && typeof ref !== "string") {
        return false;
      }
    }
    const bindings = readSceneKeyBindings(raw);
    // A string that is neither "default" nor a credential id is malformed,
    // not a refusal to read into it.
    if (Object.keys(bindings).length !== Object.keys(raw).length) {
      return false;
    }
    if (Object.keys(bindings).length > 0) {
      result[sceneId] = bindings;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** The `service_keys` column as a map, tolerating whatever an older row holds. */
export function sceneServiceKeysOf(stored: unknown): SceneServiceKeys | null {
  const read = readServiceKeysField(stored);
  return read === false || read === undefined ? null : read;
}

/**
 * The owner's bindings for one runtime scene of an install: by its id, or,
 * for a version with exactly one runtime scene and a column with exactly one
 * entry, that entry (a republish that re-ided its only scene keeps the
 * owner's choice) — the rule layouts and button maps follow.
 */
export function serviceKeysForRuntimeScene(
  keys: SceneServiceKeys | null,
  runtimeSceneId: string,
  runtimeSceneCount: number,
): SceneKeyBindings | undefined {
  if (!keys) {
    return undefined;
  }
  const own = keys[runtimeSceneId];
  if (own) {
    return own;
  }
  const entries = Object.values(keys);
  return runtimeSceneCount === 1 && entries.length === 1 ? entries[0] : undefined;
}
