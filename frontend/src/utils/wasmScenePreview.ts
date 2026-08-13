import type { FrameType } from '../types'

// Pure pieces of the cloud fleet's wasm preview fallback (FrameImage +
// models/wasmPreviewModel): the render-result cache and the one-at-a-time
// render queue. When a tile has no device snapshot and no store cover, the
// assigned scene is rendered in-browser by the frameos-wasm worker and the
// captured bitmap fills the tile.
//
// Deliberately import-free beyond the type barrel (type-only, erased at
// compile time): the cloud app's node test suite exercises these helpers
// directly.

/** Renders are seconds-long and memory-heavy; cap the bitmap cache. */
export const WASM_PREVIEW_CACHE_MAX = 30

type PreviewFrame = Pick<FrameType, 'id' | 'width' | 'height' | 'rotate' | 'cloud_scene_sources'>

/**
 * The scene canvas has the rotated ("render") dimensions; the device rotates
 * the finished image afterwards. Mirrors livePreviewLogic.previewDimensions.
 */
export function wasmPreviewDimensions(frame: Pick<FrameType, 'width' | 'height' | 'rotate'>): {
  width: number
  height: number
} {
  const width = frame.width || 800
  const height = frame.height || 480
  return frame.rotate === 90 || frame.rotate === 270 ? { width: height, height: width } : { width, height }
}

/**
 * Cache key for one rendered bitmap. The scene version (from the store-scene
 * assignment that hydrated this runtime scene) and the render dimensions are
 * part of the key, so a pinned-version bump or a resize re-renders while the
 * 15s fleet poll keeps hitting the cache.
 */
export function wasmPreviewCacheKey(frame: PreviewFrame, sceneId: string): string {
  const version = frame.cloud_scene_sources?.[sceneId]?.scene_version ?? 'latest'
  const { width, height } = wasmPreviewDimensions(frame)
  return `${frame.id}:${sceneId}:${version}:${width}x${height}`
}

/**
 * Insert (or refresh) one cache entry, evicting the oldest entries beyond
 * `cap`. Entries are recency-ordered by (re)insertion — plain object key
 * order. `dataUrl: null` is a tombstone: the render failed, don't retry in a
 * loop.
 */
export function withWasmPreviewEntry(
  state: Record<string, string | null>,
  key: string,
  dataUrl: string | null,
  cap: number = WASM_PREVIEW_CACHE_MAX
): Record<string, string | null> {
  const next: Record<string, string | null> = {}
  for (const [existingKey, value] of Object.entries(state)) {
    if (existingKey !== key) {
      next[existingKey] = value
    }
  }
  next[key] = dataUrl
  const keys = Object.keys(next)
  for (const stale of keys.slice(0, Math.max(0, keys.length - cap))) {
    delete next[stale]
  }
  return next
}

export interface WasmPreviewQueue<T> {
  /** False when the key is already queued or rendering (deduped). */
  enqueue(key: string, task: () => Promise<T>): boolean
  isQueued(key: string): boolean
}

/**
 * Serial task queue: at most one task runs at a time (N visible tiles must
 * not spawn N wasm workers), duplicate keys are dropped while queued or
 * in-flight, and a rejected task reports `null` so the caller can cache a
 * tombstone.
 */
export function createWasmPreviewQueue<T>(onDone: (key: string, result: T | null) => void): WasmPreviewQueue<T> {
  const pending: { key: string; task: () => Promise<T> }[] = []
  const keys = new Set<string>()
  let running = false

  const pump = async (): Promise<void> => {
    if (running) {
      return
    }
    const next = pending.shift()
    if (!next) {
      return
    }
    running = true
    let result: T | null = null
    try {
      result = await next.task()
    } catch {
      result = null
    }
    keys.delete(next.key)
    running = false
    try {
      onDone(next.key, result)
    } finally {
      void pump()
    }
  }

  return {
    enqueue(key: string, task: () => Promise<T>): boolean {
      if (keys.has(key)) {
        return false
      }
      keys.add(key)
      pending.push({ key, task })
      void pump()
      return true
    },
    isQueued(key: string): boolean {
      return keys.has(key)
    },
  }
}
