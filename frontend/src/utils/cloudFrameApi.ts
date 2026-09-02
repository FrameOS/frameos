import type { FrameSchedule, FrameScene, FrameType } from '../types'
import { apiFetch } from './apiFetch'
import type { CloudFrameSceneRow } from './cloudFrameScenes'
import {
  allCloudFrameSettingKeys,
  cloudFrameSettingKeys,
  cloudFrameSettingKeysForVersion,
  cloudFrameSettingsPayload,
  cloudFrameSupportsExtendedSettings,
  cloudFrameSupportsHardwareSettings,
  cloudFrameSupportsEsp32ExtendedSettings,
  esp32CloudFrameSettingKeysForVersion,
  esp32ExtendedCloudFrameSettingsMinVersion,
  esp32TimeZoneCloudFrameSettingsMinVersion,
  cloudFrameSupportsEsp32TimeZone,
  esp32BatteryEnablePinCloudFrameSettingsMinVersion,
  cloudFrameSupportsEsp32BatteryEnablePin,
  extendedCloudFrameSettingKeys,
  extendedCloudFrameSettingsMinVersion,
  hardwareCloudFrameSettingKeys,
  hardwareCloudFrameSettingsMinVersion,
  type CloudFrameSettingKey,
} from './cloudFrameSettings'
import { isEsp32CloudFrame } from '../scenes/workspace/workspaceSurfaces'
import type { FrameId } from './frameId'

// FrameOS Cloud speaks a much narrower dialect than the FrameOS backend: an
// enqueued command from a short verb list, or a declarative settings push.
// There is no deploy and no shell. The canonical frame routes the SPA shares
// with the backend — POST /api/frames/{id} (rename), /restart, /reboot and
// the /event/{render,setCurrentScene,uploadScenes} shim — exist on the cloud
// as aliases onto that queue, so feature code calls them with no cloud
// branch. This module holds what has no canonical twin: the settings
// allowlist push, schedule, scene assignment, account scenes, and the
// update-notify nudge.
//
// Wire contract: cloud/apps/auth-web/app/api/frames/[frameId]/{command,settings}
// and cloud/docs/cloud-frames.md.

/** allowedFrameCommandTypes in cloud/apps/auth-web/src/lib/frames.ts. */
export type CloudFrameCommand =
  | 'notify_update_available'
  | 'reboot'
  | 'render'
  | 'restart_runtime'
  | 'set_current_scene'

// The settings allowlist and its payload builder live in the import-free
// cloudFrameSettings module (it is unit-tested from the cloud app's node
// suite); re-exported here so callers keep one import.
export {
  cloudFrameSettingKeys,
  cloudFrameSettingKeysForVersion,
  cloudFrameSettingsPayload,
  cloudFrameSupportsExtendedSettings,
  cloudFrameSupportsHardwareSettings,
  cloudFrameSupportsEsp32ExtendedSettings,
  cloudFrameSupportsEsp32TimeZone,
  cloudFrameSupportsEsp32BatteryEnablePin,
  esp32ExtendedCloudFrameSettingsMinVersion,
  esp32TimeZoneCloudFrameSettingsMinVersion,
  esp32BatteryEnablePinCloudFrameSettingsMinVersion,
  extendedCloudFrameSettingKeys,
  extendedCloudFrameSettingsMinVersion,
  hardwareCloudFrameSettingKeys,
  hardwareCloudFrameSettingsMinVersion,
}
export type { CloudFrameSettingKey }
export type { CloudFrameSceneRow }

// Compile-time guard: every allowlisted key must be a real FrameType field, so
// a rename in the form cannot leave a dead key on the wire.
const cloudFrameSettingKeysAreFrameFields: readonly (keyof FrameType)[] = allCloudFrameSettingKeys
void cloudFrameSettingKeysAreFrameFields

async function assertOk(response: Response, fallback: string): Promise<void> {
  if (response.ok) {
    return
  }
  const detail = (await response.json().catch(() => ({}))) as { error?: string }
  throw new Error(detail.error ? `${fallback} (${detail.error})` : fallback)
}

export async function sendCloudFrameCommand(
  frameId: FrameId,
  type: CloudFrameCommand,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const response = await apiFetch(`/api/frames/${frameId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...payload }),
  })
  await assertOk(response, `Failed to send "${type}" to the frame`)
}

/**
 * Push the declarative settings subset. Returns false when nothing in the
 * form maps onto a cloud setting — the caller should then not report success
 * for a request it never made.
 */
export async function pushCloudFrameSettings(frameId: FrameId, frame: Partial<FrameType>): Promise<boolean> {
  // The power keys exist only in the ESP32 firmware's set_settings profile;
  // the Pi runtime refuses the whole push on a key it does not know. The
  // extended batch is the mirror image: Pi/Linux only, and only on firmware
  // that knows it (cloudFrameSupportsExtendedSettings) — older firmware
  // refuses the whole push on the first unknown key.
  const keys = isEsp32CloudFrame(frame)
    ? esp32CloudFrameSettingKeysForVersion(frame.frameos_version)
    : cloudFrameSettingKeysForVersion(frame.frameos_version)
  const settings = cloudFrameSettingsPayload(frame, keys)
  if (Object.keys(settings).length === 0) {
    return false
  }
  const response = await apiFetch(`/api/frames/${frameId}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string; min_frameos_version?: string }
    if (detail.error === 'settings_need_newer_firmware') {
      throw new Error(
        `Some of these settings need FrameOS ${
          detail.min_frameos_version ?? extendedCloudFrameSettingsMinVersion
        } or newer on the frame — update it first`
      )
    }
    throw new Error(
      detail.error ? `Failed to save the frame settings (${detail.error})` : 'Failed to save the frame settings'
    )
  }
  return true
}

/**
 * The owner's per-frame switch for service-settings delivery: whether this
 * frame's link holds `settings:services`, i.e. whether the device may pull the
 * account's Unsplash/OpenAI/… keys (cloud/docs/cloud-frames.md, "Service
 * settings"). Turning it off REMOVES the scope, so the device's next pull is a
 * 403 and it drops every cloud-owned key it holds.
 */
export async function setCloudFrameServiceSettingsEnabled(frameId: FrameId, enabled: boolean): Promise<void> {
  const response = await apiFetch(`/api/frames/${frameId}/service-settings/enabled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  await assertOk(response, `Failed to ${enabled ? 'enable' : 'disable'} service settings for this frame`)
}

/**
 * The owner's per-frame switch for telemetry: whether this frame's link holds
 * `telemetry:logs` + `telemetry:metrics`, i.e. whether the device ships its
 * logs and metrics to the cloud. Scopes are pinned per connection, so the
 * cloud restarts the frame's runtime to apply the change either way.
 */
export async function setCloudFrameTelemetryEnabled(frameId: FrameId, enabled: boolean): Promise<void> {
  const response = await apiFetch(`/api/frames/${frameId}/telemetry/enabled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  await assertOk(response, `Failed to ${enabled ? 'enable' : 'disable'} log shipping for this frame`)
}

/**
 * Push the Schedule panel's edits. Schedule is its own verb (`set_schedule`),
 * not a settings key: POST /api/frames/{id}/schedule persists the full
 * schedule server-side (disabled events included, so the panel round-trips)
 * and enqueues a durable, TTL-less set_schedule with the events the device
 * should actually fire.
 */
export async function pushCloudFrameSchedule(frameId: FrameId, schedule: FrameSchedule): Promise<void> {
  const response = await apiFetch(`/api/frames/${frameId}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schedule,
      // Schedules match in frame-local wall-clock time, but the smallest
      // devices carry no tz database — ship the browser's current UTC offset
      // alongside (getTimezoneOffset is minutes *behind* UTC, so negate).
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
    }),
  })
  await assertOk(response, 'Failed to save the frame schedule')
}

// ---------------------------------------------------------------------------
// Cloud deploy: the ad-hoc scene push.
//
// The cloud has no POST /api/frames/{id}/deploy — its deploy primitive for
// the workspace's edited (frameForm) scenes is the event shim
// POST /api/frames/{id}/event/uploadScenes, which turns {scenes, sceneId?,
// state?} into a checksummed, durable set_scenes command
// (cloud/apps/auth-web/app/api/frames/[frameId]/event/[eventName]/route.ts).
// A push deliberately does NOT touch store-scene assignments: the workspace
// showing "out of sync" afterwards is the truth about an ad-hoc scene set.

/** Mirrors the shim's maxScenesPerUpload / maxScenesPayloadBytes limits. */
export const cloudSceneUploadLimit = 20
const cloudSceneUploadPayloadLimitMb = 3

const uploadedScenePrefix = 'uploaded/'

/**
 * Which scene a deploy push should activate: the frame's currently active
 * scene, so deploying updated content never yanks the display to another
 * scene. The runtime reports ad-hoc scenes as "uploaded/<id>" — strip that.
 * Activating an id that is not in the pushed set would strand the frame, so
 * fall back to "let the runtime pick" (payload sceneId or first) instead.
 */
export function cloudDeployActiveSceneId(
  activeSceneId: string | null | undefined,
  scenes: readonly { id?: string }[]
): string | undefined {
  if (!activeSceneId) {
    return undefined
  }
  const sceneId = activeSceneId.startsWith(uploadedScenePrefix)
    ? activeSceneId.slice(uploadedScenePrefix.length)
    : activeSceneId
  return sceneId && scenes.some((scene) => scene.id === sceneId) ? sceneId : undefined
}

/** The shim's 4xx error codes, translated for the deploy task toast. */
export function cloudSceneDeployErrorMessage(code: string | null | undefined, status: number): string {
  switch (code) {
    case 'scenes_payload_too_large':
      return `These scenes are too large to push to a cloud frame (${cloudSceneUploadPayloadLimitMb} MB limit)`
    case 'invalid_scenes':
      return `A cloud deploy pushes between 1 and ${cloudSceneUploadLimit} scenes`
    case 'frame_not_active':
      return 'This frame is still pending — confirm it on its dashboard before deploying to it'
    default:
      return code ? `Failed to deploy the scenes (${code})` : `Failed to deploy the scenes (HTTP ${status})`
  }
}

/**
 * Push the workspace's current scene list to a cloud-managed frame. This IS
 * the cloud's deploy: durable and checksummed, applied when the device syncs
 * (battery frames spend most of their life asleep). Pass `sceneId` to keep or
 * set the active scene; without it the runtime activates the first scene.
 * Throws with a toast-ready message on the shim's size/count/state 4xxs.
 */
export async function deployCloudFrameScenes(
  frameId: FrameId,
  scenes: readonly Partial<FrameScene>[],
  options: { sceneId?: string; state?: Record<string, any> } = {}
): Promise<void> {
  const response = await apiFetch(`/api/frames/${frameId}/event/uploadScenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenes,
      ...(options.sceneId ? { sceneId: options.sceneId } : {}),
      ...(options.state ? { state: options.state } : {}),
    }),
  })
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(cloudSceneDeployErrorMessage(detail.error, response.status))
  }
}

/**
 * The store scenes assigned to a cloud-managed frame, in position order
 * (GET /api/frames/{frameId}/scenes). These are STORE scene ids — the runtime
 * scene JSON lives at /api/store/scenes/{scene_id}/scenes.json.
 */
export async function listCloudFrameScenes(frameId: FrameId): Promise<CloudFrameSceneRow[]> {
  const response = await apiFetch(`/api/frames/${frameId}/scenes`)
  await assertOk(response, 'Failed to load the frame scene list')
  const data = (await response.json()) as { scenes?: CloudFrameSceneRow[] }
  return data.scenes ?? []
}

/**
 * Replace a cloud frame's assignment list outright and push it to the device
 * (POST /api/frames/{id}/scenes enqueues the checksummed set_scenes). Pass
 * `activeSceneId` (a RUNTIME scene id) to keep the current scene on screen —
 * the device otherwise activates the first scene of the payload.
 */
export async function setCloudFrameScenes(
  frameId: FrameId,
  scenes: readonly CloudSceneAssignmentInput[],
  activeSceneId?: string
): Promise<void> {
  const response = await apiFetch(`/api/frames/${frameId}/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenes: scenes.map(cloudSceneAssignmentEntry),
      ...(activeSceneId ? { scene_id: activeSceneId } : {}),
    }),
  })
  await assertOk(response, 'Failed to update the frame scene list')
}

/**
 * One entry of POST /api/frames/{id}/scenes. `settings_groups` is the
 * owner's GRANT of the account's service keys to this scene on this frame
 * (cloud/docs/cloud-frames.md, "Service settings"): the server stores it
 * narrowed to what the scene declares. Omitted keeps an assigned scene's
 * current grant and gives a newly added scene none — so every caller that
 * adds a scene the owner picked passes the declared groups here.
 */
export interface CloudSceneAssignmentInput {
  scene_id: string
  scene_version?: number | null
  settings_groups?: string[] | undefined
}

function cloudSceneAssignmentEntry(scene: CloudSceneAssignmentInput): Record<string, unknown> {
  return {
    scene_id: scene.scene_id,
    ...(scene.scene_version ? { scene_version: scene.scene_version } : {}),
    ...(scene.settings_groups ? { settings_groups: scene.settings_groups } : {}),
  }
}

/**
 * Install (or re-pin) one store scene on a cloud frame, granting it the given
 * service-settings groups — what the chat's Install card does when the user
 * approves an AI proposal. Read-modify-write like assignCloudFrameStoreScene:
 * the endpoint replaces the whole list. `settingsGroups` are the group NAMES
 * the scene declares (unsplash, openAI, …); the server stores them on the
 * assignment as the grant.
 */
export async function installCloudFrameStoreScene(
  frameId: FrameId,
  sceneId: string,
  sceneVersion: number | null,
  settingsGroups: string[]
): Promise<void> {
  const existing = await listCloudFrameScenes(frameId)
  const entry = cloudSceneAssignmentEntry({
    scene_id: sceneId,
    scene_version: sceneVersion,
    settings_groups: settingsGroups,
  })
  // Other rows keep their pin and their grant; the proposed scene takes the
  // grant the card showed, in its current slot when it is already assigned.
  const scenes = existing.map((scene) =>
    scene.scene_id === sceneId
      ? entry
      : cloudSceneAssignmentEntry({
          scene_id: scene.scene_id,
          scene_version: scene.scene_version ?? null,
          settings_groups: scene.granted_settings_groups,
        })
  )
  if (!existing.some((scene) => scene.scene_id === sceneId)) {
    scenes.push(entry)
  }
  const response = await apiFetch(`/api/frames/${frameId}/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenes }),
  })
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string; detail?: string }
    throw new Error(detail.detail || cloudSceneDeployErrorMessage(detail.error, response.status))
  }
}

/**
 * The scenes.json body of a store scene — the exact payload the device
 * receives over set_scenes, carrying the runtime scene ids. Null when the
 * scene is unreadable (pulled, network) so callers can leave it untouched.
 */
export async function fetchStoreSceneScenesJson(storeSceneId: string): Promise<FrameScene[] | null> {
  try {
    const response = await apiFetch(`/api/store/scenes/${storeSceneId}/scenes.json`)
    if (!response.ok) {
      return null
    }
    const json = await response.json()
    return Array.isArray(json) && json.length > 0 ? (json as FrameScene[]) : null
  } catch {
    return null
  }
}

/**
 * Create a NEW private cloud scene from raw scenes JSON
 * (POST /api/account/scenes — cloud only). Returns the store scene id.
 */
export async function createCloudAccountScene(
  name: string,
  scenes: readonly Partial<FrameScene>[],
  description?: string,
  /**
   * Take the new scene's preview from this frame's snapshot cache — the
   * cover an uploaded zip left there, or the device's own render. Resolved
   * server-side; the image never travels through the browser. Best effort:
   * a frame with nothing cached simply yields a scene without a preview.
   */
  previewFromFrame?: { frameId: FrameId; sceneId: string }
): Promise<string> {
  const response = await apiFetch(`/api/account/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      scenes,
      ...(description ? { description } : {}),
      ...(previewFromFrame
        ? { preview_from_frame: { frame_id: String(previewFromFrame.frameId), scene_id: previewFromFrame.sceneId } }
        : {}),
    }),
  })
  await assertOk(response, `Failed to save "${name}" to your cloud scenes`)
  const data = (await response.json()) as { scene?: { id?: string } }
  if (!data.scene?.id) {
    throw new Error(`Failed to save "${name}" to your cloud scenes (no scene id returned)`)
  }
  return data.scene.id
}

/**
 * Replace a private cloud scene's contents with new scenes JSON, publishing a
 * new immutable version (POST /api/account/scenes/{id}/content). Returns the
 * new version number when the server reports one.
 */
export async function updateCloudAccountSceneContent(
  storeSceneId: string,
  scenes: readonly Partial<FrameScene>[]
): Promise<number | undefined> {
  const response = await apiFetch(`/api/account/scenes/${storeSceneId}/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenes }),
  })
  await assertOk(response, 'Failed to save the scene changes to your cloud scenes')
  const data = (await response.json()) as { scene?: { version?: number } }
  return typeof data.scene?.version === 'number' ? data.scene.version : undefined
}

/**
 * Assign a store scene to a cloud-managed frame. This is the cloud's actual
 * scene contract: POST /api/frames/{id}/scenes takes the full ordered list of
 * STORE scene ids, persists it server-side and enqueues a set_scenes push to
 * the device — nothing here rides the settings allowlist. Read-modify-write
 * because the endpoint replaces the whole list. Returns false when the scene
 * was already assigned (nothing sent).
 */
export async function assignCloudFrameStoreScene(
  frameId: FrameId,
  sceneId: string,
  /**
   * The service-settings groups to grant the new scene — the groups its apps
   * declare, as the owner saw them when choosing it. Without this the scene
   * is served no keys (cloud/docs/cloud-frames.md, "Service settings").
   */
  settingsGroups: readonly string[] = []
): Promise<boolean> {
  const existing = await listCloudFrameScenes(frameId)
  if (existing.some((scene) => scene.scene_id === sceneId)) {
    return false
  }
  const response = await apiFetch(`/api/frames/${frameId}/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenes: [
        // Existing rows keep their grant explicitly (a row from before the
        // grant existed becomes explicit on this save, as the docs promise).
        ...existing.map((scene) =>
          cloudSceneAssignmentEntry({
            scene_id: scene.scene_id,
            // null/undefined = track the latest published version.
            scene_version: scene.scene_version ?? null,
            settings_groups: scene.granted_settings_groups ?? [],
          })
        ),
        cloudSceneAssignmentEntry({ scene_id: sceneId, settings_groups: [...settingsGroups] }),
      ],
    }),
  })
  await assertOk(response, 'Failed to add the scene to the frame')
  return true
}
