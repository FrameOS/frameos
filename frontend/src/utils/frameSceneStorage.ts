import type { FrameScene, FrameType } from '../types'
import { formatBytes } from '../scenes/settings/account/format'

/** What an ESP32's state partition holds, as the frame reports it: in
 * `hardware.storage` to a cloud frame's hello, in `embedded.storage` on a
 * backend frame (fos_scenes_add_storage_json in the firmware). Every number is
 * in the partition's own units, the pages taken, data and index alike
 * (fos_spiffs_footprint.c): a scene's size, the scenes' sum and the used
 * figure add up the way the partition fills. */
export interface FrameSceneStorage {
  stateTotalBytes: number
  stateUsedBytes: number
  scenesBytes: number
  sceneCount: number
  /** Each scene's footprint by scene id; empty from firmware that does not say. */
  sceneBytes: Record<string, number>
}

function sceneBytesOf(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const sizes: Record<string, number> = {}
  for (const [id, bytes] of Object.entries(value as Record<string, unknown>)) {
    if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) {
      sizes[id] = bytes
    }
  }
  return sizes
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
    sceneBytes: sceneBytesOf(reported.sceneBytes),
  }
}

/** Free space first: the partition is small (a 1 MB one holds about 950 KB),
 * and what fits is the question. */
export function frameStorageLabel(frame: Pick<FrameType, 'hardware' | 'embedded'>): string | null {
  const storage = frameSceneStorage(frame)
  if (!storage) {
    return null
  }
  const free = Math.max(0, storage.stateTotalBytes - storage.stateUsedBytes)
  return `${formatBytes(free)} free of ${formatBytes(storage.stateTotalBytes)} on the frame, scenes ${formatBytes(
    storage.scenesBytes
  )}`
}

const sizes = new WeakMap<object, number>()

/** A scene's JSON, which is close to what the frame stores of it: for a scene
 * the frame has not reported (not on it yet, or older firmware). */
export function sceneJsonBytes(scene: FrameScene): number {
  let size = sizes.get(scene)
  if (size === undefined) {
    size = new TextEncoder().encode(JSON.stringify(scene)).length
    sizes.set(scene, size)
  }
  return size
}

/** What the scene takes on the frame: the frame's own figure when it reported
 * one, else its JSON's size, marked "~". */
export function sceneSizeLabel(scene: FrameScene, frame?: Pick<FrameType, 'hardware' | 'embedded'>): string {
  const reported = frame ? frameSceneStorage(frame)?.sceneBytes[scene.id] : undefined
  return reported !== undefined ? formatBytes(reported) : `~${formatBytes(sceneJsonBytes(scene))}`
}
