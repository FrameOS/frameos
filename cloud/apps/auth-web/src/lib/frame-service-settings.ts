// The service keys a cloud-managed frame receives, and the exact bytes it
// fetches. Wire contract: docs/service-keys.md ("On the wire") and
// docs/cloud-frames.md ("Service settings"); the rules are the shared
// frontend/src/utils/serviceKeys.ts, pinned by docs/service-keys-fixtures.json.
//
// Keys travel over a device-authed HTTPS pull, never over the WebSocket
// command queue: frame_commands rows are never deleted, so a pushed secret
// would live in Postgres and every backup forever, would pass through the
// hub, and could be redelivered after the owner deleted it. The socket only
// carries a zero-payload `refresh_service_settings` nudge.

import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  frameSceneAssignments,
  storeScenes,
  type createDb,
} from "@frameos-cloud/db";
import {
  buildServiceKeysWire,
  type ServiceKeysScene,
  type ServiceKeysWire,
} from "../../../../../frontend/src/utils/serviceKeys";
import {
  computeAndStoreServiceSettingGroups,
  grantedSettingsGroupsForAssignment,
  scenePreviewScene,
} from "./frames";
import {
  declaredServicesOfScene,
  readSceneServices,
  sceneServiceKeysOf,
  serviceKeysForRuntimeScene,
} from "./scene-services";

export type ServiceSettingsPayload = {
  // One set of values per service bound anywhere on the frame, for runtimes
  // that read `settings` alone (docs/service-keys.md).
  settings: Record<string, Record<string, string>>;
  // Every service bound to some scene (a refused one is not): the groups the
  // cloud owns on the device, which deletes any other it took from the cloud.
  groups: string[];
  // Each runtime scene's own keys: what a runtime that reads it uses.
  serviceKeys: ServiceKeysWire;
};

// Stable bytes for the ETag and the response: JSON.stringify with sorted keys
// at every level, so re-saving the same values in a different order does not
// invalidate every frame's cached copy.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function serviceSettingsEtag(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex")}"`;
}

/** One assignment row's service-key picture: the raw columns. */
export type ServiceKeysAssignment = {
  declaredSettingsGroups: unknown;
  grantedSettingsGroups: unknown;
  sceneServices: unknown;
  serviceKeys: unknown;
};

/**
 * The runtime scenes of a frame's assignments, as buildServiceKeysWire takes
 * them: each one's declared services (settled into `scene_services`), the
 * owner's key choice for it (`service_keys`), and the assignment's grant as
 * the older rule (a NULL grant: all it declares, as such rows were assigned
 * under). Pure.
 */
export function serviceKeysScenesForAssignments(
  assignments: readonly ServiceKeysAssignment[],
): ServiceKeysScene[] {
  const scenes: ServiceKeysScene[] = [];
  for (const assignment of assignments) {
    const services = readSceneServices(assignment.sceneServices) ?? {};
    const runtimeIds = Object.keys(services);
    const keys = sceneServiceKeysOf(assignment.serviceKeys);
    const legacyGranted = grantedSettingsGroupsForAssignment(assignment);
    for (const id of runtimeIds) {
      const declared = services[id] ?? [];
      if (declared.length === 0) {
        continue;
      }
      const bound = serviceKeysForRuntimeScene(keys, id, runtimeIds.length);
      scenes.push({
        declared,
        id,
        legacyGranted,
        ...(bound ? { keys: bound } : {}),
      });
    }
  }
  return scenes;
}

/**
 * The preview a frame shows (docs/scene-previews.md) bound by the older rule
 * with no `keys` (docs/service-keys.md "Which key a scene gets"): a scene the
 * account made gets the defaults of what it declares, a stranger's store
 * scene nothing. `ownScene` says whether it is the account's.
 */
export function previewServiceKeysScene(
  scene: Record<string, unknown>,
  ownScene: boolean,
): ServiceKeysScene | null {
  const id = typeof scene.id === "string" ? scene.id : "";
  const declared = declaredServicesOfScene(scene);
  if (!id || declared.length === 0) {
    return null;
  }
  return { declared, id, legacyGranted: ownScene ? declared : [] };
}

/**
 * What a frame receives, from its runtime scenes and the account's stored
 * settings (revealed: the default key of a service is the group of its
 * name, the rest in `serviceCredentials`).
 */
export function buildServiceSettingsPayload(
  scenes: readonly ServiceKeysScene[],
  storedSettings: Record<string, unknown>,
): ServiceSettingsPayload {
  const { serviceKeys, settings } = buildServiceKeysWire({ scenes, settings: storedSettings });
  const groups = new Set<string>();
  for (const bindings of Object.values(serviceKeys.scenes)) {
    for (const [service, keyId] of Object.entries(bindings)) {
      if (keyId !== null) {
        groups.add(service);
      }
    }
  }
  return { groups: [...groups].sort(), serviceKeys, settings };
}

export function serviceSettingsResponseBody(payload: ServiceSettingsPayload): {
  body: string;
  etag: string;
} {
  const body = canonicalJson(payload);
  return { body, etag: serviceSettingsEtag(body) };
}

type Database = ReturnType<typeof createDb>;

/**
 * Every runtime scene of the frame that declares a service, with the inputs
 * of its bindings: the assignments (settled once, by unzipping, for rows from
 * before `scene_services`) and the standing preview.
 */
export async function frameServiceKeysScenes(
  db: Database,
  frame: { id: string; accountId: string },
  { preview: withPreview = true }: { preview?: boolean } = {},
): Promise<ServiceKeysScene[]> {
  const readRows = () =>
    db
      .select({
        declaredSettingsGroups: frameSceneAssignments.declaredSettingsGroups,
        grantedSettingsGroups: frameSceneAssignments.grantedSettingsGroups,
        sceneServices: frameSceneAssignments.sceneServices,
        serviceKeys: frameSceneAssignments.serviceKeys,
      })
      .from(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frame.id))
      .orderBy(asc(frameSceneAssignments.position));
  let rows = await readRows();
  if (
    rows.some(
      (row) => readSceneServices(row.sceneServices) === undefined || row.declaredSettingsGroups === null,
    )
  ) {
    // A row from before migration 0086 (or 0048): what its runtime scenes
    // declare is in the version's zip. Settled once here, as
    // service_setting_groups is; a set that cannot be assembled settles
    // nothing, and such rows serve nothing until the next push settles them.
    await computeAndStoreServiceSettingGroups(db, frame.id);
    rows = await readRows();
  }
  const scenes = serviceKeysScenesForAssignments(rows);
  const preview = withPreview ? await scenePreviewScene(db, frame.id) : null;
  if (preview) {
    const origin = preview.scene.origin;
    const storeSceneId =
      origin && typeof origin === "object" && !Array.isArray(origin)
        ? (origin as Record<string, unknown>).storeSceneId
        : undefined;
    // A preview with no store origin is one the plane made for this account
    // (the voice chat's show_image, the editor's unsaved scene); one with an
    // origin is the account's only when that store scene is.
    let own = storeSceneId === undefined;
    if (typeof storeSceneId === "string" && /^[0-9a-f-]{36}$/i.test(storeSceneId)) {
      const [row] = await db
        .select({ accountId: storeScenes.accountId })
        .from(storeScenes)
        .where(eq(storeScenes.id, storeSceneId))
        .limit(1);
      own = row?.accountId === frame.accountId;
    }
    const previewScene = previewServiceKeysScene(preview.scene, own);
    if (previewScene && !scenes.some((scene) => scene.id === previewScene.id)) {
      scenes.push(previewScene);
    }
  }
  return scenes;
}
