// The layout a new frame starts with, chosen where its SD card or ESP32 was
// flashed (docs/scene-layouts.md "Chosen at the flash").
//
// The SPA makes the chosen starter a private scene of the account first (the
// same POST /api/account/scenes a starter added in the workspace becomes on
// its first push), so the claim code carries only a reference: that store
// scene, the runtime id its one scene runs under, and the settings from the
// gear. It rides the token and the frame row like `scene_source_frame_id`
// and is applied by frame-provisioning.ts when the frame turns active: the
// layout is installed after the frame's other scenes and every one of them
// wears it, which is what the frame's own Layout select would have saved
// (`layouts` on each assignment row, scene-layouts.ts).

import { readSceneLayout, sceneLayoutsOf, type SceneLayoutRef } from "./scene-layouts";
import type { RequestedScene } from "./frame-scenes";

export type ProvisioningLayout = {
  /** The store scene installed as the layout. */
  storeSceneId: string;
  /** What every scene wears: the layout's runtime id and its settings. */
  layout: SceneLayoutRef;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The claim-tokens body's `layout` (`{scene_id, layout_scene_id, state?}`):
 * undefined when absent, false when malformed. Whether the scene may be
 * installed is the route's check (it must be the account's own, or public).
 */
export function readProvisioningLayoutBody(value: unknown): ProvisioningLayout | undefined | false {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!plainObject(value)) {
    return false;
  }
  const storeSceneId = typeof value.scene_id === "string" ? value.scene_id.trim() : "";
  if (!uuidPattern.test(storeSceneId)) {
    return false;
  }
  const layout = readSceneLayout({ sceneId: value.layout_scene_id, state: value.state });
  if (layout === false) {
    return false;
  }
  return { layout, storeSceneId: storeSceneId.toLowerCase() };
}

/** The column's value, tolerating whatever an older row holds. */
export function provisioningLayoutOf(stored: unknown): ProvisioningLayout | null {
  if (!plainObject(stored) || typeof stored.storeSceneId !== "string" || !uuidPattern.test(stored.storeSceneId)) {
    return null;
  }
  const layout = readSceneLayout(stored.layout);
  return layout === false ? null : { layout, storeSceneId: stored.storeSceneId.toLowerCase() };
}

/** What the column stores. */
export function provisioningLayoutColumn(provisioning: ProvisioningLayout): Record<string, unknown> {
  return { layout: provisioning.layout, storeSceneId: provisioning.storeSceneId };
}

export type RuntimeSceneOfStoreScene = { id: string; isLayout: boolean };

/**
 * The runtime scenes of a payload by the store scene they came from (each
 * pushed scene's `origin.storeSceneId`, stamped by buildScenesPayloadForFrame).
 */
export function runtimeScenesByStoreScene(scenes: readonly unknown[]): Map<string, RuntimeSceneOfStoreScene[]> {
  const byStoreScene = new Map<string, RuntimeSceneOfStoreScene[]>();
  for (const scene of scenes) {
    if (!plainObject(scene) || typeof scene.id !== "string" || !plainObject(scene.origin)) {
      continue;
    }
    const storeSceneId = scene.origin.storeSceneId;
    if (typeof storeSceneId !== "string" || !storeSceneId) {
      continue;
    }
    const key = storeSceneId.toLowerCase();
    const isLayout = plainObject(scene.settings) && scene.settings.isLayout === true;
    byStoreScene.set(key, [...(byStoreScene.get(key) ?? []), { id: scene.id, isLayout }]);
  }
  return byStoreScene;
}

/**
 * The assignments a provisioned frame starts with: the ones it was given
 * (the scene source's copy, or none), every runtime scene of theirs that is
 * not a layout wearing the chosen one, and the layout itself installed last,
 * so a push that names no scene still starts on one of the frame's own.
 */
export function withProvisioningLayout(
  requested: readonly RequestedScene[],
  runtimeScenes: ReadonlyMap<string, readonly RuntimeSceneOfStoreScene[]>,
  provisioning: ProvisioningLayout,
): RequestedScene[] {
  const result = requested
    .filter((entry) => entry.sceneId.toLowerCase() !== provisioning.storeSceneId)
    .map((entry) => {
      const contents = (runtimeScenes.get(entry.sceneId.toLowerCase()) ?? []).filter((scene) => !scene.isLayout);
      if (contents.length === 0) {
        return entry;
      }
      const layouts = { ...(sceneLayoutsOf(entry.layouts) ?? {}) };
      for (const scene of contents) {
        layouts[scene.id] = provisioning.layout;
      }
      return { ...entry, layouts };
    });
  return [...result, { sceneId: provisioning.storeSceneId, sceneVersion: null }];
}
