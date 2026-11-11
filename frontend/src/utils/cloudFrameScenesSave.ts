import type { CloudSceneSource, EventMapRule, FrameScene, SceneLayoutRef } from '../types'
import { cloudSceneHeldVersion, cloudSceneUpdateVersion, type CloudFrameSceneRow } from './cloudFrameScenes'
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
  /** Store scene id → the newer version `updateToLatest` moved it to. */
  updatedToLatest: Record<string, number>
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
  /**
   * Push only these runtime scenes (the scene drawer's push): an assignment
   * that owns none of them (by `sources`) goes out as it is, its scenes.json
   * never read. Reading every assignment back, one request each, was most of
   * a push's time on a frame with twenty scenes. A scene here that `sources`
   * does not place (new in the workspace, or a tile that never hydrated) takes
   * the whole read, so nothing is ever created twice.
   */
  only?: readonly string[]
  /** Public field values for the scene the push activates, in the same push. */
  activeState?: Record<string, any>
  /**
   * Move every scene the owner did not edit and that has a newer installable
   * version to it in this push (a pin is re-pinned there): the deploy
   * drawer's deploys. Without it a save moves only what it edited.
   */
  updateToLatest?: boolean
}

interface AssignmentPlan {
  scene_id: string
  scene_version?: number | null
  /** Push the store's newest version of this (unpinned) scene, not the held one. */
  latest?: boolean | undefined
  /** The grant this save posts for the scene; omitted = keep as is. */
  settings_groups?: string[] | undefined
  /** The install's button maps by runtime scene id; omitted = keep, null = none. */
  event_maps?: Record<string, EventMapRule[]> | null | undefined
  /** The layout each runtime scene wears, the same way. */
  layouts?: Record<string, SceneLayoutRef> | null | undefined
}

// The button maps the form holds for one pack's runtime scenes: what this
// save posts for the assignment. The map is the install's (never scene
// content), so it is read here and stripped below before any publish. Posted
// only when there is something to say: the form's maps, or null to clear the
// ones the row had; a frame without any keeps its payload as it was.
function formEventMaps(
  formScenes: readonly Partial<FrameScene>[],
  row?: Pick<CloudFrameSceneRow, 'event_maps'>
): Record<string, EventMapRule[]> | null | undefined {
  const maps: Record<string, EventMapRule[]> = {}
  for (const scene of formScenes) {
    if (scene?.id && Array.isArray(scene.eventMap) && scene.eventMap.length > 0) {
      maps[scene.id] = scene.eventMap
    }
  }
  if (Object.keys(maps).length > 0) {
    return maps
  }
  return row?.event_maps && Object.keys(row.event_maps).length > 0 ? null : undefined
}

// The layouts, the same way (docs/scene-layouts.md).
function formLayouts(
  formScenes: readonly Partial<FrameScene>[],
  row?: Pick<CloudFrameSceneRow, 'layouts'>
): Record<string, SceneLayoutRef> | null | undefined {
  const layouts: Record<string, SceneLayoutRef> = {}
  for (const scene of formScenes) {
    if (scene?.id && scene.layout?.sceneId) {
      layouts[scene.id] = scene.layout
    }
  }
  if (Object.keys(layouts).length > 0) {
    return layouts
  }
  return row?.layouts && Object.keys(row.layouts).length > 0 ? null : undefined
}

// Every save re-posts each kept assignment's grant explicitly, so a row
// from before grants existed becomes explicit on the owner's first save.
function keptGrant(row: CloudFrameSceneRow): string[] | undefined {
  return row.granted_settings_groups ?? undefined
}

// The version a kept (unedited) assignment goes out at: the one it has, or,
// when the push takes updates along, the newer one (recorded in `updated`).
function keptVersion(
  row: CloudFrameSceneRow,
  updateToLatest: boolean | undefined,
  updated: Record<string, number>
): Pick<AssignmentPlan, 'scene_version' | 'latest'> {
  const update = updateToLatest ? cloudSceneUpdateVersion(row) : null
  if (update === null) {
    return { scene_version: row.scene_version ?? null }
  }
  updated[row.scene_id] = update
  return row.scene_version ? { scene_version: update } : { scene_version: null, latest: true }
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

/**
 * The scene without the install's bookkeeping: `origin` (where it came from)
 * `eventMap` (the owner's button map, docs/events.md "Event map") and
 * `layout` (the layout it wears, docs/scene-layouts.md). All three belong to the installed copy and never to a published version: an
 * `eventMap` inside scene content would be an edit on every save and would
 * remap every other install of the scene.
 */
export function withoutSceneOrigin<T extends Partial<FrameScene>>(scene: T): T {
  if (!scene || (!('origin' in scene) && !('eventMap' in scene) && !('layout' in scene))) {
    return scene
  }
  const {
    origin: _origin,
    eventMap: _eventMap,
    layout: _layout,
    ...rest
  } = scene as T & { origin?: unknown; eventMap?: unknown; layout?: unknown }
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
  const updatedToLatest: Record<string, number> = {}
  const assignments: AssignmentPlan[] = []
  const claimedRuntimeIds = new Set<string>()

  // The store scenes that own the pushed runtime scenes, when every one of
  // them is placed; null = read every assignment (a full save).
  const only = options.only ? new Set(options.only) : null
  const pushedRows =
    only && [...only].every((id) => sources[id]?.scene_id)
      ? new Set([...only].map((id) => sources[id]!.scene_id))
      : null

  for (const row of rows) {
    if (only && pushedRows && !pushedRows.has(row.scene_id)) {
      // Not part of this push: as it is (omitted maps and layouts = kept),
      // and its runtime scenes stay claimed.
      assignments.push({
        scene_id: row.scene_id,
        scene_version: row.scene_version ?? null,
        settings_groups: keptGrant(row),
      })
      for (const [runtimeId, source] of Object.entries(sources)) {
        if (source?.scene_id === row.scene_id) {
          claimedRuntimeIds.add(runtimeId)
        }
      }
      continue
    }
    // The version the workspace hydrated the form from — what the frame was
    // sent — not the store's latest. Comparing the form against a NEWER
    // version read every scene with a pending update as edited: an owned one
    // was republished with its old content on top of the newer version, a
    // public install was forked into a private copy, per save.
    const stored = await fetchStoreSceneScenesJson(row.scene_id, cloudSceneHeldVersion(row))
    if (!stored) {
      // Unreadable (pulled scene, rate limit, transient error): keep the
      // assignment untouched rather than guessing — and claim every runtime
      // scene the workspace hydrated from it (plus a stub tile carrying the
      // store id), or they would be created again as new private scenes.
      assignments.push({
        scene_id: row.scene_id,
        ...keptVersion(row, options.updateToLatest, updatedToLatest),
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
    // The button maps this save posts: the form's, for the runtime scenes of
    // this pack (null when there are none, which clears a removed map).
    const event_maps = formEventMaps(
      presentIds.map((id) => formById.get(id)!),
      row
    )
    const layouts = formLayouts(
      presentIds.map((id) => formById.get(id)!),
      row
    )
    if (!edited) {
      assignments.push({
        scene_id: row.scene_id,
        ...keptVersion(row, options.updateToLatest, updatedToLatest),
        settings_groups: keptGrant(row),
        event_maps,
        layouts,
      })
      continue
    }

    try {
      const version = await updateCloudAccountSceneContent(row.scene_id, updated)
      changedStoreSceneIds.push(row.scene_id)
      assignments.push({
        scene_id: row.scene_id,
        // A pinned assignment follows the edit it just made; an unpinned one
        // is moved to the latest (which now IS the edit) — the only scene of
        // this push that moves, the rest stay at the version the frame holds.
        scene_version: row.scene_version ? version ?? null : null,
        latest: true,
        settings_groups: keptGrant(row),
        event_maps,
        layouts,
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
        assignments.push({
          scene_id: newSceneId,
          settings_groups: keptGrant(row) ?? grantForNew(updated),
          event_maps,
          layouts,
        })
        notes.push(`Saved the edited "${name}" as a new private cloud scene`)
      } catch (forkError) {
        const message = forkError instanceof Error ? forkError.message : String(forkError)
        notes.push(`Kept "${row.name ?? row.scene_id}" unchanged in the cloud: ${message}`)
        assignments.push({
          scene_id: row.scene_id,
          scene_version: row.scene_version ?? null,
          settings_groups: keptGrant(row),
          event_maps,
          layouts,
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
    if (only && !only.has(scene.id)) {
      // Another unsaved scene in the form: not this push's to create.
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
    assignments.push({
      scene_id: newSceneId,
      settings_groups: grantForNew([scene]),
      event_maps: formEventMaps([scene]),
      layouts: formLayouts([scene]),
    })
  }

  const pushActiveSceneId = cloudDeployActiveSceneId(activeSceneId, formScenes) ?? undefined
  await setCloudFrameScenes(
    frameId,
    assignments,
    pushActiveSceneId,
    pushActiveSceneId ? options.activeState : undefined
  )
  return { changedStoreSceneIds, notes, updatedToLatest }
}
