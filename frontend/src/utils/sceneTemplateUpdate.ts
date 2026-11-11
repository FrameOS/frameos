import type { FrameScene, SceneOrigin } from '../types'
import { remapSceneIds } from './duplicateScenes'
import { mergeInstalledFieldValues } from './sceneUpdateFields'

/**
 * What an update writes over an installed copy: its content, never its id,
 * name or default flag. A key the new version lacks is written as undefined,
 * so the copy loses it too.
 */
export type SceneUpdatePatch = {
  [K in 'nodes' | 'edges' | 'apps' | 'fields' | 'customEvents' | 'settings' | 'origin']: FrameScene[K] | undefined
}

/**
 * The backend's "update to latest" for one template's installed copies:
 * each copy takes its template scene's new content under its own id (links
 * between the template's scenes follow), and keeps the field values set on
 * it. A template scene installed twice updates both copies; one with no
 * copy is not added. The diff and the deploy both apply these.
 */
export function templateUpdatePatches(
  installed: readonly FrameScene[],
  templateScenes: readonly FrameScene[],
  originFor: (templateSceneId: string) => SceneOrigin
): Map<string, SceneUpdatePatch> {
  const patches = new Map<string, SceneUpdatePatch>()
  const first: Record<string, string> = {}
  let pending = installed.filter((scene) => scene.origin?.sceneId)
  while (pending.length > 0) {
    // One copy per template scene a pass: a scene installed twice takes a
    // second pass, its links pointing at the first copy's siblings.
    const slot: Record<string, string> = {}
    const claimed = new Set<string>()
    for (const scene of pending) {
      const templateSceneId = scene.origin!.sceneId!
      if (!(templateSceneId in slot)) {
        slot[templateSceneId] = scene.id
        first[templateSceneId] ??= scene.id
        claimed.add(scene.id)
      }
    }
    const remapped = remapSceneIds([...templateScenes], (id) => slot[id] ?? first[id] ?? id)
    templateScenes.forEach((templateScene, index) => {
      const installedId = slot[templateScene.id]
      const next = remapped[index]
      if (!installedId || !next) {
        return
      }
      const copy = installed.find((scene) => scene.id === installedId)
      patches.set(installedId, {
        nodes: next.nodes,
        edges: next.edges,
        apps: next.apps,
        fields: mergeInstalledFieldValues(copy?.fields, next.fields),
        customEvents: next.customEvents,
        settings: next.settings,
        origin: originFor(templateScene.id),
      })
    })
    pending = pending.filter((scene) => !claimed.has(scene.id))
  }
  return patches
}
