import type { CloudSceneSource, FrameScene } from '../types'
import type { CloudFrameSceneRow } from './cloudFrameScenes'
import {
  cloudDeployActiveSceneId,
  createCloudAccountScene,
  fetchStoreSceneScenesJson,
  listCloudFrameScenes,
  setCloudFrameScenes,
  updateCloudAccountSceneContent,
} from './cloudFrameApi'
import type { FrameId } from './frameId'

// Cloud "Save & Deploy" persistence (cloud-workspace-fixes): the edited scene
// graphs in the workspace form become durable server-side state instead of an
// ad-hoc set_scenes push that only the device remembers.
//
//   * a form scene that came from an assigned store scene updates that store
//     scene's contents (a new immutable version via /api/account/scenes/
//     {id}/content) — multi-scene packs keep their other scenes;
//   * a form scene with no owning assignment becomes a NEW private cloud
//     scene (/api/account/scenes) and is appended to the assignment list;
//   * assignments whose every runtime scene was removed from the form are
//     dropped;
//   * finally the full assignment list goes to POST /api/frames/{id}/scenes,
//     which persists it and enqueues the checksummed set_scenes push — the
//     deploy. The device's scenes_checksum then matches assigned_checksum,
//     so the workspace shows in-sync and /scene_images resolves server truth.
//
// Editing a store scene the account does NOT own (a public install) cannot
// update in place; the fallback forks the edited content into a new private
// scene and swaps the assignment to it.
//
// Two things this must never do, because both happened (the account ended
// up with "Abstract Architecture 2" … "8", each a copy nobody asked for):
//
//   * treat an UNEDITED scene as edited. The form holds a sanitized copy of
//     scenes.json (positions filled in, defaults materialized), so a byte
//     comparison against the stored JSON always says "changed" — which
//     republished every owned scene on every settings save and FORKED every
//     assigned scene the account does not own into a private copy, per save.
//     Callers pass the same scene equality the workspace uses for its own
//     "unsaved changes" badge (`sceneUnchanged`); the raw fallback stays only
//     for callers that have nothing better.
//   * mistake "could not read this pack right now" for "this pack has no
//     scenes on the frame". A stub tile (scenes.json fetch failed, or a 429
//     on the store's rate limit) carries the STORE id, so its runtime scenes
//     look unowned and get created again as new private scenes. The caller's
//     `sources` (runtime id → assignment, recorded at hydration) claims them
//     instead, and the assignment stays untouched.
//
// A third: the `origin` stamp on an installed scene (store page, uuid and
// version — what the frame is running) never belongs INSIDE a published
// scene. The store stamps every scene it serves from the version row that
// produced it (scenes.json, the zip, the device push), so the stored zip
// stays the publisher's bytes and the stamp can never lag. Persisting it
// used to turn every install into a perpetual edit: the stored copy carried
// origin.version N-1, the form the freshly stamped N, so each save published
// a new version (or a new fork) whose stamp then lagged again. It is dropped
// from both the comparison and the payloads here, whatever the caller's
// equality does.
//
// Saves for one frame are also serialized: two clicks in one second used to
// run the flow twice from the same starting list and fork twice ("7" and
// "7").

export interface CloudScenePersistOutcome {
  /** Store scene ids whose content changed or that were newly created. */
  changedStoreSceneIds: string[]
  /** Human-readable notes for non-fatal fallbacks (shown in the deploy toast). */
  notes: string[]
}

export interface CloudScenePersistOptions {
  /**
   * "Is the form's copy of this scene the same scene the store holds?"
   * `stored` is the raw scenes.json entry, `form` the workspace's (sanitized)
   * scene with the same id. Defaults to a raw JSON comparison, which is only
   * right when the caller never sanitized — pass the workspace's comparison
   * (sanitize the stored one the same way, then compare) from real callers.
   */
  sceneUnchanged?: (stored: FrameScene, form: FrameScene) => boolean
  /**
   * Runtime scene id → the store-scene assignment it was hydrated from
   * (framesModel's cloud_scene_sources). Used to keep a pack's scenes claimed
   * when its scenes.json cannot be re-read during the save.
   */
  sources?: Record<string, CloudSceneSource> | null
  /**
   * The service-settings groups to GRANT a scene that becomes a new private
   * cloud scene on this save (built in the workspace, or a fork of an edited
   * public install): the groups its apps declare, as the owner built it.
   * Without it a new scene is served no keys
   * (cloud/docs/cloud-frames.md, "Service settings").
   */
  settingsGroupsForNewScene?: (scenes: readonly FrameScene[]) => string[]
}

interface AssignmentPlan {
  scene_id: string
  scene_version?: number | null
  /** The grant this save posts for the scene; omitted = keep as is. */
  settings_groups?: string[] | undefined
}

// Every save re-posts each kept assignment's grant explicitly, so a row
// from before grants existed becomes explicit on the owner's first save.
function keptGrant(row: CloudFrameSceneRow): string[] | undefined {
  return row.granted_settings_groups ?? undefined
}

function sceneName(scene: Partial<FrameScene>): string {
  return (scene.name ?? '').trim() || 'Untitled scene'
}

// The new private scene's preview: whatever the frame's snapshot cache holds
// for the first runtime scene — the cover an uploaded zip left there, or the
// device's own render. Without this a scene uploaded from a zip kept its
// tile only until the cache evicted it and never showed a cover in "my cloud
// scenes" at all.
function coverHint(
  frameId: FrameId,
  scenes: readonly Partial<FrameScene>[]
): { frameId: FrameId; sceneId: string } | undefined {
  const sceneId = scenes.find((scene) => typeof scene?.id === 'string' && scene.id)?.id
  return sceneId ? { frameId, sceneId } : undefined
}

function rawSceneUnchanged(stored: FrameScene, form: FrameScene): boolean {
  return JSON.stringify(stored) === JSON.stringify(form)
}

/** The scene without the client-side install bookkeeping (`origin`). */
export function withoutSceneOrigin<T extends Partial<FrameScene>>(scene: T): T {
  if (!scene || !('origin' in scene)) {
    return scene
  }
  const { origin: _origin, ...rest } = scene as T & { origin?: unknown }
  return rest as T
}

// One save at a time per frame: a second call waits for the first to finish
// (and then sees the assignment list the first one wrote).
const savesInFlight = new Map<FrameId, Promise<unknown>>()

/**
 * Persist the workspace's edited scene list server-side, then push the
 * resulting assignment list to the device. Throws only when the final push
 * fails — per-scene persistence failures degrade to notes so one refused
 * scene does not lose the rest of the save.
 */
export async function persistAndPushCloudFrameScenes(
  frameId: FrameId,
  formScenes: readonly FrameScene[],
  activeSceneId?: string | null,
  options: CloudScenePersistOptions = {}
): Promise<CloudScenePersistOutcome> {
  const previous = savesInFlight.get(frameId) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(() => persistAndPushCloudFrameScenesNow(frameId, formScenes, activeSceneId, options))
  savesInFlight.set(frameId, run)
  try {
    return await run
  } finally {
    if (savesInFlight.get(frameId) === run) {
      savesInFlight.delete(frameId)
    }
  }
}

async function persistAndPushCloudFrameScenesNow(
  frameId: FrameId,
  formScenes: readonly FrameScene[],
  activeSceneId: string | null | undefined,
  options: CloudScenePersistOptions
): Promise<CloudScenePersistOutcome> {
  const sceneUnchanged = options.sceneUnchanged ?? rawSceneUnchanged
  const sources = options.sources ?? {}
  const grantForNew = (scenes: readonly FrameScene[]): string[] | undefined =>
    options.settingsGroupsForNewScene ? options.settingsGroupsForNewScene(scenes) : undefined
  const rows = await listCloudFrameScenes(frameId)
  const formById = new Map<string, FrameScene>()
  for (const scene of formScenes) {
    if (scene?.id) {
      formById.set(scene.id, scene)
    }
  }

  const changedStoreSceneIds: string[] = []
  const notes: string[] = []
  const assignments: AssignmentPlan[] = []
  const claimedRuntimeIds = new Set<string>()

  for (const row of rows) {
    const stored = await fetchStoreSceneScenesJson(row.scene_id)
    if (!stored) {
      // Unreadable (pulled scene, rate limit, transient error): keep the
      // assignment untouched rather than guessing — and claim every runtime
      // scene the workspace hydrated from it (plus a stub tile carrying the
      // store id), or they would be created again as new private scenes.
      assignments.push({
        scene_id: row.scene_id,
        scene_version: row.scene_version ?? null,
        settings_groups: keptGrant(row),
      })
      if (formById.has(row.scene_id)) {
        claimedRuntimeIds.add(row.scene_id)
      }
      for (const [runtimeId, source] of Object.entries(sources)) {
        if (source?.scene_id === row.scene_id && formById.has(runtimeId)) {
          claimedRuntimeIds.add(runtimeId)
        }
      }
      continue
    }

    const storedIds = stored.map((scene) => scene.id).filter(Boolean)
    const presentIds = storedIds.filter((id) => formById.has(id))
    for (const id of presentIds) {
      claimedRuntimeIds.add(id)
    }
    if (presentIds.length === 0) {
      // Every runtime scene of this pack was removed from the frame.
      continue
    }

    const updated = stored.map((scene) => {
      const form = formById.get(scene.id)
      return form ? withoutSceneOrigin(form) : scene
    })
    const edited = stored.some((scene, index) => {
      const form = updated[index]
      return !!form && form !== scene && !sceneUnchanged(withoutSceneOrigin(scene), form)
    })
    if (!edited) {
      assignments.push({
        scene_id: row.scene_id,
        scene_version: row.scene_version ?? null,
        settings_groups: keptGrant(row),
      })
      continue
    }

    try {
      const version = await updateCloudAccountSceneContent(row.scene_id, updated)
      changedStoreSceneIds.push(row.scene_id)
      assignments.push({
        scene_id: row.scene_id,
        // A pinned assignment follows the edit it just made; an unpinned one
        // keeps tracking latest (which now IS the edit).
        scene_version: row.scene_version ? (version ?? null) : null,
        settings_groups: keptGrant(row),
      })
    } catch (error) {
      // Not ours to edit (public install), name clash, moderation… — fork the
      // edited content into a new private scene and swap the assignment.
      try {
        const name = row.name || sceneName(updated[0] ?? {})
        const newSceneId = await createCloudAccountScene(name, updated, undefined, coverHint(frameId, updated))
        changedStoreSceneIds.push(newSceneId)
        // The fork inherits what the original was granted, narrowed to what
        // the edited copy still declares (the server intersects).
        assignments.push({ scene_id: newSceneId, settings_groups: keptGrant(row) ?? grantForNew(updated) })
        notes.push(`Saved the edited "${name}" as a new private cloud scene`)
      } catch (forkError) {
        const message = forkError instanceof Error ? forkError.message : String(forkError)
        notes.push(`Kept "${row.name ?? row.scene_id}" unchanged in the cloud: ${message}`)
        assignments.push({
          scene_id: row.scene_id,
          scene_version: row.scene_version ?? null,
          settings_groups: keptGrant(row),
        })
      }
    }
  }

  // Scenes with no owning assignment: newly created in the workspace (or
  // deployed ad-hoc before this flow existed). Each becomes its own private
  // cloud scene, in form order.
  for (const scene of formScenes) {
    if (!scene?.id || claimedRuntimeIds.has(scene.id)) {
      continue
    }
    const name = sceneName(scene)
    const newSceneId = await createCloudAccountScene(name, [withoutSceneOrigin(scene)], undefined, {
      frameId,
      sceneId: scene.id,
    })
    changedStoreSceneIds.push(newSceneId)
    // A scene the owner built here is granted what its apps declare — that
    // is the owner choosing it, the same consent as picking a template.
    assignments.push({ scene_id: newSceneId, settings_groups: grantForNew([scene]) })
  }

  await setCloudFrameScenes(
    frameId,
    assignments,
    cloudDeployActiveSceneId(activeSceneId, formScenes) ?? undefined
  )
  return { changedStoreSceneIds, notes }
}
