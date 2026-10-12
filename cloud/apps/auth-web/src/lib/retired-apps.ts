// Built-in Nim apps retired in favour of a repo JavaScript app
// (docs/retired-apps.json; prose in docs/retired-apps.md). `data/immich`
// became the scene-local JS app from repo/apps/code/immich, which needs
// `frameos.fetchImage` and so a runtime from 2026.10.11 on.
//
// The cloud never rewrites a stored version (zips are immutable), so the cut
// is made where scenes are READ, next to the `origin` stamp (scene-origin.ts):
//
// - `retireAppsInScenes` turns a retired keyword into the JS app for every
//   reader that shows, renders or edits scenes (the workspace's scenes.json,
//   the server render, the AI tools);
// - `scenesForRuntime` is what a frame is SENT (buildScenesPayloadForFrame):
//   a runtime older than the replacement still has the Nim app and lacks what
//   the JS app needs, so it gets the retired keyword back. The hub redeploys
//   when a frame's firmware version changes and that changes the payload.
//
// Pinned to the backend's backend/app/utils/retired_apps.py by
// docs/retired-apps-fixtures.json (retired-apps.test.ts).

import { REPLACEMENT_APPS, RETIRED_APPS } from "./retired-apps.gen";
import { frameosVersionKey, compareFrameosVersions } from "./store-versions";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function appNodes(scene: JsonObject): JsonObject[] {
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  return nodes.filter(
    (node): node is JsonObject => isObject(node) && node.type === "app" && isObject(node.data),
  );
}

function keywordOf(node: JsonObject): unknown {
  return (node.data as JsonObject).keyword;
}

function hasOwnSources(node: JsonObject): boolean {
  const sources = (node.data as JsonObject).sources;
  return isObject(sources) ? Object.keys(sources).length > 0 : Boolean(sources);
}

function selected(keywords: Iterable<string> | undefined): Set<string> {
  return new Set(keywords ?? Object.keys(RETIRED_APPS));
}

// The scene-local app a replacement becomes: its config.json keys plus
// `origin` and `sources`, as a fresh copy.
export function replacementAppEntry(origin: string): JsonObject {
  const entry = REPLACEMENT_APPS[origin];
  if (!entry) {
    throw new Error(`No generated copy of ${origin}; run frameos/tools/generate_retired_apps.py`);
  }
  return structuredClone(entry);
}

// Rewrite retired keywords in place. A node carrying its own `data.sources`
// is a self-contained edited copy and is left alone. Returns whether
// anything changed.
export function retireAppsInScenes(scenes: unknown, keywords?: Iterable<string>): boolean {
  if (!Array.isArray(scenes)) {
    return false;
  }
  const wanted = selected(keywords);
  let changed = false;
  for (const scene of scenes) {
    if (!isObject(scene)) {
      continue;
    }
    for (const [keyword, spec] of Object.entries(RETIRED_APPS)) {
      if (!wanted.has(keyword)) {
        continue;
      }
      const nodes = appNodes(scene).filter((node) => keywordOf(node) === keyword && !hasOwnSources(node));
      if (nodes.length === 0) {
        continue;
      }
      let apps = isObject(scene.apps) ? scene.apps : undefined;
      let key = apps
        ? Object.keys(apps).find((name) => isObject(apps?.[name]) && (apps[name] as JsonObject).origin === spec.replacement)
        : undefined;
      if (key === undefined) {
        if (!apps) {
          apps = {};
          scene.apps = apps;
        }
        key = spec.sceneAppKey;
        let suffix = 2;
        while (key in apps) {
          key = `${spec.sceneAppKey}${suffix}`;
          suffix += 1;
        }
        apps[key] = replacementAppEntry(spec.replacement);
      }
      for (const node of nodes) {
        (node.data as JsonObject).keyword = key;
      }
      changed = true;
    }
  }
  return changed;
}

// Give a runtime that predates the replacements the retired keywords back, in
// place: the nodes of a scene-local app whose `origin` is a replacement get
// the retired keyword, and the entry goes (and `apps` with it, once empty).
export function restoreAppsInScenes(scenes: unknown, keywords?: Iterable<string>): boolean {
  if (!Array.isArray(scenes)) {
    return false;
  }
  const wanted = selected(keywords);
  const byOrigin = new Map(
    Object.entries(RETIRED_APPS)
      .filter(([keyword]) => wanted.has(keyword))
      .map(([keyword, spec]) => [spec.replacement, keyword] as const),
  );
  let changed = false;
  for (const scene of scenes) {
    if (!isObject(scene) || !isObject(scene.apps)) {
      continue;
    }
    const apps = scene.apps;
    let sceneChanged = false;
    for (const key of Object.keys(apps)) {
      const app = apps[key];
      const keyword = isObject(app) && typeof app.origin === "string" ? byOrigin.get(app.origin) : undefined;
      if (keyword === undefined) {
        continue;
      }
      for (const node of appNodes(scene)) {
        if (keywordOf(node) === key) {
          (node.data as JsonObject).keyword = keyword;
        }
      }
      delete apps[key];
      sceneChanged = true;
    }
    if (sceneChanged && Object.keys(apps).length === 0) {
      delete scene.apps;
    }
    changed = changed || sceneChanged;
  }
  return changed;
}

// The retired keywords whose replacement this runtime cannot run yet. An
// unknown or unreadable version counts as none — a frame that never reported
// one is a fresh install of the current release.
export function keywordsRuntimeLacks(runtimeVersion: string | null | undefined): string[] {
  const version = typeof runtimeVersion === "string" ? runtimeVersion.trim().replace(/^v/, "") : runtimeVersion;
  if (!frameosVersionKey(version)) {
    return [];
  }
  return Object.entries(RETIRED_APPS)
    .filter(([, spec]) => compareFrameosVersions(version, spec.runtime) < 0)
    .map(([keyword]) => keyword);
}

// A copy of `scenes` as a runtime of `runtimeVersion` must receive them.
export function scenesForRuntime<T>(scenes: T[], runtimeVersion: string | null | undefined): T[] {
  const result = structuredClone(scenes);
  const lacking = keywordsRuntimeLacks(runtimeVersion);
  restoreAppsInScenes(result, lacking);
  retireAppsInScenes(
    result,
    Object.keys(RETIRED_APPS).filter((keyword) => !lacking.includes(keyword)),
  );
  return result;
}

// A converted copy, for readers that show, edit or render scenes.
export function withRetiredAppsReplaced<T>(scenes: T[]): T[] {
  const result = structuredClone(scenes);
  retireAppsInScenes(result);
  return result;
}
