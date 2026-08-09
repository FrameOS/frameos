import type { FrameScene, FrameType } from '../types'
import type { WorkspaceMode } from '../scenes/workspace/workspaceSurfaces'

// Which scenes are not on the frame yet — the input to the scene drawer's
// "This scene has changes that are not on the frame yet" notice.
//
// The three control planes answer this from different evidence, and getting
// the cloud one wrong is why every cloud scene claimed to be undeployed even
// straight after a successful push:
//
//   * backend  — the frame row carries `last_successful_deploy.scenes`, the
//     exact graphs SSH last installed, so the comparison is per scene.
//   * cloud    — there is no such field, and nothing writes one. A cloud
//     deploy is a checksummed `set_scenes` push: `assigned_checksum` is what
//     the account assigned, `scenes_checksum` is what the device acknowledged
//     (the same pair the account frames table renders as "in sync" /
//     "sync pending"). Reading `last_successful_deploy` there compared every
//     scene against an empty list, so all of them were permanently pending.
//     A single checksum covers the whole set, so this is all-or-nothing: it
//     cannot say WHICH scene differs, only that the device is behind.
//   * frameAdmin — the frame is the thing being edited; there is nowhere to
//     deploy to.
export function undeployedSceneIdsFor({
  mode,
  scenes,
  frame,
  scenesEqual,
}: {
  mode: WorkspaceMode
  scenes: readonly FrameScene[]
  frame: FrameType | null | undefined
  /** Injected so this module stays free of the frameLogic import cycle. */
  scenesEqual: (a: FrameScene, b: FrameScene) => boolean
}): Set<string> {
  if (mode === 'frameAdmin') {
    return new Set<string>()
  }

  if (mode === 'cloud') {
    const assigned = frame?.assigned_checksum
    const reported = frame?.scenes_checksum
    // Both present and equal: the device has acknowledged exactly this set.
    if (assigned && reported && assigned === reported) {
      return new Set<string>()
    }
    // Nothing assigned yet and nothing on the device either — an empty frame
    // has nothing pending, and claiming otherwise makes a fresh frame look
    // dirty before the user has done anything.
    if (!assigned && !reported) {
      return new Set<string>()
    }
    return new Set(scenes.map((scene) => scene.id))
  }

  const deployedScenes: FrameScene[] = frame?.last_successful_deploy?.scenes ?? []
  const undeployed = new Set<string>()
  scenes.forEach((scene) => {
    const deployed = deployedScenes.find((deployedScene) => deployedScene.id === scene.id)
    if (!deployed || !scenesEqual(scene, deployed)) {
      undeployed.add(scene.id)
    }
  })
  return undeployed
}
