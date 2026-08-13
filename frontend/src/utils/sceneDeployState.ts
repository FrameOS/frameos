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
//   * cloud    — a cloud deploy is a checksummed `set_scenes` push:
//     `assigned_checksum` is what the account assigned, `scenes_checksum` is
//     what the device acknowledged (the same pair the account frames table
//     renders as "in sync" / "sync pending"). When they differ, the
//     per-scene ledger narrows the blame: `assigned_scene_state` holds each
//     store scene's slice of the last push, `deployed_scene_state` the copy
//     the hub took when the device last acked a push, and
//     `cloud_scene_sources` (hydration-owned) maps runtime scene ids back to
//     their store scenes. Only scenes whose slice changed are flagged.
//     Frames that predate the ledger (null maps) fall back to the old
//     all-or-nothing answer: every scene pending until the checksums agree.
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
    // Per-scene ledger: flag only the store scenes whose assigned slice
    // differs from the last device-acked push. Needs the hydration-recorded
    // runtime→store mapping; a runtime scene with no known source (a stub
    // tile, an ad-hoc preview) counts as pending.
    const assignedState = frame?.assigned_scene_state
    const sources = frame?.cloud_scene_sources
    if (assignedState && sources) {
      const deployedState = frame?.deployed_scene_state ?? {}
      const undeployed = new Set<string>()
      scenes.forEach((scene) => {
        const source = sources[scene.id]
        const assignedSlice = source ? assignedState[source.scene_id] : undefined
        if (!assignedSlice || assignedSlice.checksum !== deployedState[source!.scene_id]?.checksum) {
          undeployed.add(scene.id)
        }
      })
      return undeployed
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
