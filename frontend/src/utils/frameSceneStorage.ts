import type { FrameScene, FrameType } from '../types'
import { formatBytes } from '../scenes/settings/account/format'

/** What an ESP32's state partition holds, as the frame reports it: in
 * `hardware.storage` to a cloud frame's hello, in `embedded.storage` on a
 * backend frame (fos_scenes_storage_summary in the firmware). */
export interface FrameSceneStorage {
  stateTotalBytes: number
  stateUsedBytes: number
  scenesBytes: number
  sceneCount: number
}

export function frameSceneStorage(frame: Pick<FrameType, 'hardware' | 'embedded'>): FrameSceneStorage | null {
  const reported = frame.hardware?.storage ?? frame.embedded?.storage
  if (!reported || !reported.stateTotalBytes) {
    return null
  }
  return {
    stateTotalBytes: reported.stateTotalBytes,
    stateUsedBytes: reported.stateUsedBytes ?? 0,
    scenesBytes: reported.scenesBytes ?? 0,
    sceneCount: reported.sceneCount ?? 0,
  }
}

export function frameStorageLabel(frame: Pick<FrameType, 'hardware' | 'embedded'>): string | null {
  const storage = frameSceneStorage(frame)
  if (!storage) {
    return null
  }
  return `${formatBytes(storage.stateUsedBytes)} of ${formatBytes(
    storage.stateTotalBytes
  )} used on the frame, scenes ${formatBytes(storage.scenesBytes)}`
}

const sizes = new WeakMap<object, number>()

/** A scene's size on the frame: its JSON, which is what the frame stores. */
export function sceneJsonBytes(scene: FrameScene): number {
  let size = sizes.get(scene)
  if (size === undefined) {
    size = new TextEncoder().encode(JSON.stringify(scene)).length
    sizes.set(scene, size)
  }
  return size
}

export function sceneSizeLabel(scene: FrameScene): string {
  return formatBytes(sceneJsonBytes(scene))
}
