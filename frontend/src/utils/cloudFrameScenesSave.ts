import type { FrameScene } from '../types'
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

export interface CloudScenePersistOutcome {
  /** Store scene ids whose content changed or that were newly created. */
  changedStoreSceneIds: string[]
  /** Human-readable notes for non-fatal fallbacks (shown in the deploy toast). */
  notes: string[]
}

interface AssignmentPlan {
  scene_id: string
  scene_version?: number | null
}

function sceneName(scene: Partial<FrameScene>): string {
  return (scene.name ?? '').trim() || 'Untitled scene'
}

function scenesEqual(a: readonly Partial<FrameScene>[], b: readonly Partial<FrameScene>[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Persist the workspace's edited scene list server-side, then push the
 * resulting assignment list to the device. Throws only when the final push
 * fails — per-scene persistence failures degrade to notes so one refused
 * scene does not lose the rest of the save.
 */
export async function persistAndPushCloudFrameScenes(
  frameId: FrameId,
  formScenes: readonly FrameScene[],
  activeSceneId?: string | null
): Promise<CloudScenePersistOutcome> {
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
      // Unreadable (pulled scene, transient error): keep the assignment
      // untouched rather than guessing — its runtime scenes also stay
      // unclaimed, which would duplicate them as new private scenes, so
      // claim whatever the form still holds under this assignment's id.
      assignments.push({ scene_id: row.scene_id, scene_version: row.scene_version ?? null })
      if (formById.has(row.scene_id)) {
        claimedRuntimeIds.add(row.scene_id)
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

    const updated = stored.map((scene) => formById.get(scene.id) ?? scene)
    if (scenesEqual(stored, updated)) {
      assignments.push({ scene_id: row.scene_id, scene_version: row.scene_version ?? null })
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
      })
    } catch (error) {
      // Not ours to edit (public install), name clash, moderation… — fork the
      // edited content into a new private scene and swap the assignment.
      try {
        const name = row.name || sceneName(updated[0] ?? {})
        const newSceneId = await createCloudAccountScene(name, updated)
        changedStoreSceneIds.push(newSceneId)
        assignments.push({ scene_id: newSceneId })
        notes.push(`Saved the edited "${name}" as a new private cloud scene`)
      } catch (forkError) {
        const message = forkError instanceof Error ? forkError.message : String(forkError)
        notes.push(`Kept "${row.name ?? row.scene_id}" unchanged in the cloud: ${message}`)
        assignments.push({ scene_id: row.scene_id, scene_version: row.scene_version ?? null })
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
    const newSceneId = await createCloudAccountScene(name, [scene])
    changedStoreSceneIds.push(newSceneId)
    assignments.push({ scene_id: newSceneId })
  }

  await setCloudFrameScenes(
    frameId,
    assignments,
    cloudDeployActiveSceneId(activeSceneId, formScenes) ?? undefined
  )
  return { changedStoreSceneIds, notes }
}
