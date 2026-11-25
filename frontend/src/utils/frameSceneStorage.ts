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

export type FrameStorageTone = 'ok' | 'filling' | 'full'

/** One scene's footprint on the frame, for the storage popup. */
export interface FrameStorageScene {
  id: string
  /** From the frame's scene list; null for a scene the list does not hold
   * (one the frame has that was never imported, say): shown by its id. */
  name: string | null
  bytes: number
}

/** What the frame's disk indicator and its popup show: the partition's
 * numbers made whole (used never over the total), what the scenes take, and
 * what everything else takes (assets kept on the frame, saved scene state, the
 * frame's own files). */
export interface FrameStorageSummary {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  usedPercent: number
  scenesBytes: number
  sceneCount: number
  otherBytes: number
  /** Each scene the frame reported a size for, largest first. */
  scenes: FrameStorageScene[]
}

/** Used, in whole percent. Never 0 while something is stored, never 100
 * until nothing is free: a rounded "100%" on a frame that still takes a scene
 * would say the opposite of what is true. */
export function storageUsedPercent(usedBytes: number, totalBytes: number): number {
  if (!(totalBytes > 0)) {
    return 0
  }
  const used = Math.max(0, Math.min(usedBytes, totalBytes))
  const percent = Math.round((used / totalBytes) * 100)
  if (used > 0 && percent === 0) {
    return 1
  }
  if (used < totalBytes && percent === 100) {
    return 99
  }
  return percent
}

/** Color band for how full the partition is: fine below 80%, filling up to
 * 95%, full from there. */
export function frameStorageTone(usedPercent: number): FrameStorageTone {
  if (usedPercent >= 95) {
    return 'full'
  }
  if (usedPercent >= 80) {
    return 'filling'
  }
  return 'ok'
}

export function frameStorageSummary(
  frame: Pick<FrameType, 'hardware' | 'embedded'> & { scenes?: Pick<FrameScene, 'id' | 'name'>[] | null }
): FrameStorageSummary | null {
  const storage = frameSceneStorage(frame)
  if (!storage) {
    return null
  }
  const totalBytes = storage.stateTotalBytes
  const usedBytes = Math.max(0, Math.min(storage.stateUsedBytes, totalBytes))
  const names = new Map<string, string>()
  for (const scene of frame.scenes ?? []) {
    if (scene?.id && scene.name?.trim()) {
      names.set(scene.id, scene.name.trim())
    }
  }
  const scenes = Object.entries(storage.sceneBytes)
    .map(([id, bytes]) => ({ id, name: names.get(id) ?? null, bytes }))
    .sort((a, b) => b.bytes - a.bytes || (a.name ?? a.id).localeCompare(b.name ?? b.id))
  return {
    totalBytes,
    usedBytes,
    freeBytes: totalBytes - usedBytes,
    usedPercent: storageUsedPercent(usedBytes, totalBytes),
    scenesBytes: storage.scenesBytes,
    sceneCount: storage.sceneCount,
    otherBytes: Math.max(0, usedBytes - storage.scenesBytes),
    scenes,
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
