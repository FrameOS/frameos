import type { FrameScene, FrameType } from '../types'
import { apiFetch } from './apiFetch'
import type { CloudFrameSceneRow } from './cloudFrameScenes'
import { cloudFrameSettingKeys, cloudFrameSettingsPayload, type CloudFrameSettingKey } from './cloudFrameSettings'
import type { FrameId } from './frameId'

// FrameOS Cloud speaks a much narrower dialect than the FrameOS backend: an
// enqueued command with one of four verbs, or a declarative settings push.
// There is no POST /api/frames/{id}, no /event/*, no deploy, no shell. The
// shared SPA used to call the backend paths in cloud mode too, so Save and
// Render always errored — everything cloud-bound goes through here instead.
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
export { cloudFrameSettingKeys, cloudFrameSettingsPayload }
export type { CloudFrameSettingKey }
export type { CloudFrameSceneRow }

// Compile-time guard: every allowlisted key must be a real FrameType field, so
// a rename in the form cannot leave a dead key on the wire.
const cloudFrameSettingKeysAreFrameFields: readonly (keyof FrameType)[] = cloudFrameSettingKeys
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
  const settings = cloudFrameSettingsPayload(frame)
  if (Object.keys(settings).length === 0) {
    return false
  }
  const response = await apiFetch(`/api/frames/${frameId}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
  await assertOk(response, 'Failed to save the frame settings')
  return true
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
  scenes: readonly { scene_id: string; scene_version?: number | null }[],
  activeSceneId?: string
): Promise<void> {
  const response = await apiFetch(`/api/frames/${frameId}/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenes: scenes.map((scene) => ({
        scene_id: scene.scene_id,
        ...(scene.scene_version ? { scene_version: scene.scene_version } : {}),
      })),
      ...(activeSceneId ? { scene_id: activeSceneId } : {}),
    }),
  })
  await assertOk(response, 'Failed to update the frame scene list')
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
  description?: string
): Promise<string> {
  const response = await apiFetch(`/api/account/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, scenes, ...(description ? { description } : {}) }),
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
export async function assignCloudFrameStoreScene(frameId: FrameId, sceneId: string): Promise<boolean> {
  const existing = await listCloudFrameScenes(frameId)
  if (existing.some((scene) => scene.scene_id === sceneId)) {
    return false
  }
  const response = await apiFetch(`/api/frames/${frameId}/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenes: [
        ...existing.map((scene) => ({
          scene_id: scene.scene_id,
          // null/undefined = track the latest published version.
          ...(scene.scene_version ? { scene_version: scene.scene_version } : {}),
        })),
        { scene_id: sceneId },
      ],
    }),
  })
  await assertOk(response, 'Failed to add the scene to the frame')
  return true
}
