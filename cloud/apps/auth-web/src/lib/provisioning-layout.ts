// The layout a new frame starts with, chosen where its SD card or ESP32 was
// flashed (docs/scene-layouts.md "Chosen at the flash").
//
// The claim code's body carries the chosen starter itself: its scene (the
// gear's values as its fields' defaults) and those values. The claim route
// makes it a private scene of the account through the one save path
// (createAccountScene), or reuses the copy an earlier flash made of exactly
// that content (provisioningLayoutScene): the copy's runtime id is derived
// from its content, and the store_scene_imports ledger, the one a
// re-enrolled frame's import dedupes on, remembers which draft holds it. So
// flashing the same choice again adds no "Windows 98 2". The token and then
// the frame row keep a reference, like `scene_source_frame_id`, applied by
// frame-provisioning.ts when the frame turns active: the layout is installed
// after the frame's other scenes and every one of them wears it, which is
// what the frame's own Layout select would have saved (`layouts` on each
// assignment row, scene-layouts.ts).

import { and, eq } from "drizzle-orm";
import { storeSceneImports, storeScenes, type createDb } from "@frameos-cloud/db";
import type { NextResponse } from "next/server";
import { createAccountScene } from "./account-scene-create";
import { deviceSceneContentSha256, deviceSceneName } from "./device-scenes";
import { readSceneLayout, sceneLayoutsOf, type SceneLayoutRef } from "./scene-layouts";
import type { RequestedScene } from "./frame-scenes";
import type { PublishActor } from "./store-publish";

type Database = ReturnType<typeof createDb>;

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

/** The claim-tokens body's `layout`: the starter to install and its settings. */
export type ProvisioningLayoutRequest = {
  scene: Record<string, unknown>;
  state?: Record<string, unknown>;
};

/**
 * The claim-tokens body's `layout` (`{scene, state?}`, the scene a layout):
 * undefined when absent, false when malformed. What the scene holds is the
 * save path's to judge (zip validation, the layout rule, moderation).
 */
export function readProvisioningLayoutBody(value: unknown): ProvisioningLayoutRequest | undefined | false {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!plainObject(value) || !plainObject(value.scene) || !plainObject(value.scene.settings)) {
    return false;
  }
  if (value.scene.settings.isLayout !== true) {
    return false;
  }
  // The settings are held to what a worn layout's state may be.
  const ref = readSceneLayout({ sceneId: "layout", state: value.state });
  if (ref === false) {
    return false;
  }
  return { scene: value.scene, ...(ref.state ? { state: ref.state } : {}) };
}

/**
 * The starter as the account's scene: the draft an earlier flash made of
 * exactly this content, else a new one through the one save path. Its
 * runtime id is a function of its content, so the same starter with the
 * same settings is the same scene and a different choice is a new copy.
 * The save's own response when it refused.
 */
export async function provisioningLayoutScene(
  db: Database,
  input: { accountId: string; actor: PublishActor; request: ProvisioningLayoutRequest },
): Promise<ProvisioningLayout | NextResponse> {
  const { id: _id, origin: _origin, ...content } = input.request.scene;
  const hex = deviceSceneContentSha256(content);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const scene = { ...content, id };
  const digest = deviceSceneContentSha256(scene);
  const layout: SceneLayoutRef = input.request.state ? { sceneId: id, state: input.request.state } : { sceneId: id };
  const [kept] = await db
    .select({ sceneId: storeSceneImports.sceneId })
    .from(storeSceneImports)
    .innerJoin(storeScenes, eq(storeScenes.id, storeSceneImports.sceneId))
    .where(
      and(
        eq(storeSceneImports.accountId, input.accountId),
        eq(storeSceneImports.contentSha256, digest),
        eq(storeScenes.accountId, input.accountId),
        eq(storeScenes.status, "active"),
      ),
    )
    .limit(1);
  if (kept) {
    return { layout, storeSceneId: kept.sceneId };
  }
  const response = await createAccountScene(db, {
    accountId: input.accountId,
    actor: input.actor,
    name: deviceSceneName(scene),
    scenes: [scene],
  });
  const body = (await response
    .clone()
    .json()
    .catch(() => ({}))) as { scene?: { id?: string; version?: number } };
  if (!response.ok || !body.scene?.id || typeof body.scene.version !== "number") {
    return response;
  }
  await db
    .insert(storeSceneImports)
    .values({
      accountId: input.accountId,
      contentSha256: digest,
      deviceSceneId: id,
      sceneId: body.scene.id,
      sceneVersion: body.scene.version,
    })
    // Two flashes at once: the first ledger row stands, the second copy is
    // merely unrecorded.
    .onConflictDoNothing();
  return { layout, storeSceneId: body.scene.id };
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
