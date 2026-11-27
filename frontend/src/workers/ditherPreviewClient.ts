// Runs OpenDisplay dithering for the settings previews in
// ditherPreview.worker.ts, so a DBS pass never freezes the page. Only the
// worker imports the package, so its WASM build stays out of the page's
// bundle. The built worker loads by fixed URL (frontend/build.mjs,
// cloud-frontend/build.mjs); the Vite dev server serves the source instead.
// Where neither starts, ditherPreview rejects and the preview falls back to
// Floyd-Steinberg.

import { getAssetsBasePath } from '../utils/getBasePath'
import type { DitherPreviewInk, DitherPreviewOptions, DitherPreviewResponse } from './ditherPreviewProtocol'

const workerUrls = (): string[] => [
  `${getAssetsBasePath()}/static/workers/ditherPreview.worker.js`,
  new URL('./ditherPreview.worker.ts', import.meta.url).href,
]
let worker: Worker | null | undefined
let urlIndex = 0
let nextId = 1
const pending = new Map<number, { resolve: (indices: Uint8Array) => void; reject: (error: Error) => void }>()

function failAll(error: Error): void {
  for (const { reject } of pending.values()) {
    reject(error)
  }
  pending.clear()
}

function previewWorker(): Worker | null {
  if (worker !== undefined) {
    return worker
  }
  const url = workerUrls()[urlIndex]
  if (!url) {
    worker = null
    return worker
  }
  try {
    worker = new Worker(url, { type: 'module' })
    worker.onmessage = (event: MessageEvent<DitherPreviewResponse>) => {
      const waiting = pending.get(event.data.id)
      pending.delete(event.data.id)
      if (!waiting) {
        return
      }
      if ('error' in event.data) {
        waiting.reject(new Error(event.data.error))
      } else {
        waiting.resolve(new Uint8Array(event.data.indices))
      }
    }
    worker.onerror = (event) => {
      // A worker that could not load: the next call tries the next URL.
      event.preventDefault()
      worker?.terminate()
      worker = undefined
      urlIndex += 1
      failAll(new Error('worker unavailable'))
    }
  } catch {
    worker = undefined
    urlIndex += 1
    return previewWorker()
  }
  return worker
}

/** One wire index per pixel (into `inks`), dithered by OpenDisplay. */
export async function ditherPreview(
  width: number,
  height: number,
  data: Uint8ClampedArray,
  inks: DitherPreviewInk[],
  options: DitherPreviewOptions
): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = previewWorker()
    if (!target) {
      break
    }
    const copy = data.slice()
    const id = nextId++
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        target.postMessage({ id, width, height, data: copy.buffer, inks, options }, [copy.buffer])
      })
    } catch (error) {
      if (worker === target) {
        throw error
      }
      // That worker failed to load: try the next one.
    }
  }
  throw new Error('No dithering worker could start')
}
