import type { FrameScene } from '../types'
import { parseRefreshSeconds, resolveRefreshInterval } from './refreshInterval'
import { withAppPermissions } from './sceneAccess'
import { referencedSceneIds } from './scenePush'

// The scenes a preview sends, on the frame (uploadScenes) or in the browser
// (the wasm runtime): the scene with the values entered for it seeded in, and
// every scene it draws or switches to.

const applyStateToSceneFields = (scene: FrameScene, state: Record<string, any> | null): FrameScene => {
  if (!state) {
    return scene
  }
  let seeded = scene
  if (scene.fields?.length) {
    const fields = scene.fields.map((field) => {
      if (!field?.name) {
        return field
      }
      if (Object.prototype.hasOwnProperty.call(state, field.name)) {
        return { ...field, value: String(state[field.name]) }
      }
      return field
    })
    seeded = { ...seeded, fields }
  }
  // The implicit refresh interval (utils/refreshInterval.ts) is no field of
  // the scene's: settings.refreshInterval seeds it, so the value entered for
  // it goes there. Without this a changed interval never reached a preview.
  const refreshInterval = resolveRefreshInterval(scene)
  if (refreshInterval.implicit && Object.prototype.hasOwnProperty.call(state, refreshInterval.key)) {
    const seconds = parseRefreshSeconds(state[refreshInterval.key])
    if (seconds > 0) {
      seeded = { ...seeded, settings: { ...(seeded.settings ?? {}), refreshInterval: seconds } }
    }
  }
  return seeded
}

export function collectScenePreviewPayloadScenes(
  rootScene: FrameScene,
  scenes: FrameScene[],
  resolvedState: Record<string, any> | null
): FrameScene[] {
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]))
  const result: FrameScene[] = []
  const visited = new Set<string>()

  const visit = (scene: FrameScene, isRoot = false): void => {
    if (visited.has(scene.id)) {
      return
    }
    visited.add(scene.id)
    // The preview runs what the frame will: each JS app's permissions as a
    // save leaves them, even before the edit is saved (utils/sceneAccess.ts).
    result.push(withAppPermissions(isRoot ? applyStateToSceneFields(scene, resolvedState) : scene))

    for (const referencedSceneId of referencedSceneIds(scene)) {
      const referencedScene = sceneById.get(referencedSceneId)
      if (referencedScene) {
        visit(referencedScene)
      }
    }
  }

  visit(rootScene, true)
  return result
}

/**
 * A preview sent over USB, which no control plane builds: the frame's own
 * scene list with the preview's scenes in it, a preview scene in place of the
 * listed scene of its id and the others after the list, as both planes send
 * it (backend frame_commands.previewed_scenes, cloud scene-preview-list.ts).
 * Sent alone, the bundle replaced the frame's whole set.
 */
export function sceneListWithPreview(list: readonly FrameScene[], preview: readonly FrameScene[]): FrameScene[] {
  const previewById = new Map(preview.filter((scene) => scene?.id).map((scene) => [scene.id, scene]))
  const merged = list.map((scene) => {
    const replaced = scene?.id ? previewById.get(scene.id) : undefined
    if (!replaced) {
      return scene
    }
    previewById.delete(scene.id)
    return replaced
  })
  return [...merged, ...preview.filter((scene) => scene?.id && previewById.has(scene.id))]
}
