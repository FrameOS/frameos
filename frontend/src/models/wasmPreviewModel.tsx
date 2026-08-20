import { MakeLogicType, actions, connect, kea, listeners, path, reducers } from 'kea'

import { collectScenePreviewPayloadScenes } from '../scenes/frame/panels/Scenes/scenesLogic'
import type { FrameId, FrameScene, FrameType } from '../types'
import { apiFetch } from '../utils/apiFetch'
import { assetUrl } from '../utils/assetUrl'
import { isCloudMode } from '../utils/cloudMode'
import { isFrameControlMode } from '../utils/frameControlMode'
import { getBasePath } from '../utils/getBasePath'
import { projectApiPath } from '../utils/projectApi'
import {
  createWasmPreviewQueue,
  wasmPreviewCacheKey,
  wasmPreviewDimensions,
  withWasmPreviewEntry,
} from '../utils/wasmScenePreview'
import { framesModel } from './framesModel'

// Cloud and backend modes: renders a frame's assigned scene in the browser
// via the frameos-wasm worker when a tile has no device-sourced image at
// all, and caches the captured bitmap as a data URL. Strictly a fallback —
// a device snapshot or store cover always wins (FrameImage only asks here
// once its <img> has failed), and strictly on the user's explicit click.
// One worker at a time; failures cache a tombstone so tiles don't retry in
// a loop. Frame-control mode is out: the frame's own admin serves the real
// image, and its web server has no preview proxy.

// The worker renders synchronously on init (data apps fetch inside the
// render), so the first frame is normally complete. Some scenes immediately
// re-render to settle state; keep the worker alive briefly after the first
// frame and capture the latest one.
const WASM_PREVIEW_SETTLE_MS = 1500
// A hung render must not block the queue forever. If a frame arrived by now,
// capture it; otherwise give up and tombstone.
const WASM_PREVIEW_TIMEOUT_MS = 30_000

interface CapturedFrame {
  width: number
  height: number
  buffer: ArrayBuffer
}

// App settings (API keys etc.) for data apps, like livePreviewLogic fetches
// per preview: one merged object on the cloud, assembled per frame by the
// backend. Cached per key for the session; a failed fetch degrades to no
// secrets for that render only.
const settingsJsonPromises = new Map<string, Promise<string>>()
export function fetchSettingsJson(frameId: FrameId): Promise<string> {
  const cacheKey = isCloudMode() ? 'cloud' : `frame:${frameId}`
  let promise = settingsJsonPromises.get(cacheKey)
  if (!promise) {
    promise = (async () => {
      if (isCloudMode()) {
        const response = await apiFetch('/api/settings')
        if (!response.ok) {
          throw new Error(`settings fetch failed: ${response.status}`)
        }
        return JSON.stringify((await response.json()) ?? {})
      }
      const response = await apiFetch(`/api/frames/${frameId}/scene_preview_settings`)
      if (!response.ok) {
        throw new Error(`settings fetch failed: ${response.status}`)
      }
      const data = await response.json()
      return JSON.stringify(data?.settings ?? {})
    })().catch(() => {
      settingsJsonPromises.delete(cacheKey)
      return '{}'
    })
    settingsJsonPromises.set(cacheKey, promise)
  }
  return promise
}

export async function previewProxyUrl(frameId: FrameId): Promise<string> {
  // Same-origin proxy for the runtime's CORS-blocked HTTP fetches — the same
  // per-mode endpoints livePreviewLogic resolves.
  const configuredProxyUrl = (window as any).FRAMEOS_APP_CONFIG?.preview_proxy_url
  if (typeof configuredProxyUrl === 'string' && configuredProxyUrl) {
    return configuredProxyUrl
  }
  if (isCloudMode()) {
    return getBasePath() + '/api/store/preview-proxy'
  }
  try {
    return getBasePath() + (await projectApiPath(`/api/frames/${frameId}/scene_preview_proxy`))
  } catch {
    // The render still runs; external fetches fail with CORS as before.
    return ''
  }
}

function capturedFrameToDataUrl(frame: CapturedFrame): string {
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('no 2d canvas context')
  }
  context.putImageData(new ImageData(new Uint8ClampedArray(frame.buffer), frame.width, frame.height), 0, 0)
  return canvas.toDataURL('image/png')
}

async function renderSceneToDataUrl(frame: FrameType, sceneId: string): Promise<string> {
  const sceneList = frame.scenes ?? []
  const scene = sceneList.find((item: FrameScene) => item.id === sceneId)
  if (!scene) {
    throw new Error('scene not found')
  }
  const payloadScenes = collectScenePreviewPayloadScenes(scene, sceneList, null)
  const { width, height } = wasmPreviewDimensions(frame)
  const settingsJson = await fetchSettingsJson(frame.id)
  const proxyUrl = await previewProxyUrl(frame.id)

  const worker = new Worker(assetUrl('/frameos-wasm/preview-worker.js'), { type: 'module' })
  return await new Promise<string>((resolve, reject) => {
    let latestFrame: CapturedFrame | null = null
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (settleTimer !== null) {
        clearTimeout(settleTimer)
      }
      clearTimeout(timeoutTimer)
      worker.terminate()
    }
    const capture = (): void => {
      cleanup()
      if (!latestFrame) {
        reject(new Error('preview render timed out'))
        return
      }
      try {
        resolve(capturedFrameToDataUrl(latestFrame))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const fail = (message: string): void => {
      cleanup()
      reject(new Error(message))
    }

    const timeoutTimer = setTimeout(capture, WASM_PREVIEW_TIMEOUT_MS)
    worker.onerror = (event) => {
      // A worker-level error after a good frame (e.g. a failing re-render)
      // must not discard it; the settle timer still captures.
      if (!latestFrame) {
        fail(event.message || 'preview worker failed to load')
      }
    }
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data || {}
      if (msg.type === 'frame' && msg.buffer) {
        const firstFrame = !latestFrame
        latestFrame = { width: msg.width, height: msg.height, buffer: msg.buffer }
        if (firstFrame) {
          settleTimer = setTimeout(capture, WASM_PREVIEW_SETTLE_MS)
        }
      } else if (msg.type === 'error' && !latestFrame) {
        fail(String(msg.message ?? 'preview render failed'))
      }
    }
    worker.postMessage({
      type: 'init',
      width,
      height,
      name: frame.name || 'fleet preview',
      timeZone: frame.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      scenesJson: JSON.stringify(payloadScenes),
      settingsJson,
      proxyUrl,
      sceneId: scene.id,
    })
  })
}

// Module-level so dedupe survives the model unmounting between pages. The
// sink drops the result if the model is gone — only the cache is lost.
const renderQueue = createWasmPreviewQueue<string>((key, dataUrl) => {
  wasmPreviewModel.findMounted()?.actions.setScenePreview(key, dataUrl)
})

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface wasmPreviewModelValues {
  frames: Record<FrameId, FrameType> // framesModel
  scenePreviews: Record<string, string | null>
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface wasmPreviewModelActions {
  requestScenePreview: (
    frameId: FrameId,
    sceneId: string
  ) => {
    frameId: FrameId
    sceneId: string
  }
  setScenePreview: (
    key: string,
    dataUrl: string | null
  ) => {
    dataUrl: string | null
    key: string
  }
}

export type wasmPreviewModelType = MakeLogicType<wasmPreviewModelValues, wasmPreviewModelActions>

export const wasmPreviewModel = kea<wasmPreviewModelType>([
  path(['src', 'models', 'wasmPreviewModel']),
  connect(() => ({ values: [framesModel, ['frames']] })),
  actions({
    requestScenePreview: (frameId: FrameId, sceneId: string) => ({ frameId, sceneId }),
    setScenePreview: (key: string, dataUrl: string | null) => ({ key, dataUrl }),
  }),
  reducers({
    // Cache key (utils/wasmScenePreview.wasmPreviewCacheKey) -> PNG data URL,
    // or null for a failed render (tombstone).
    scenePreviews: [
      {} as Record<string, string | null>,
      {
        setScenePreview: (state, { key, dataUrl }) => withWasmPreviewEntry(state, key, dataUrl),
      },
    ],
  }),
  listeners(({ values }) => ({
    requestScenePreview: ({ frameId, sceneId }) => {
      if (isFrameControlMode()) {
        return
      }
      const frame = values.frames[frameId]
      if (!frame) {
        return
      }
      const key = wasmPreviewCacheKey(frame, sceneId)
      if (key in values.scenePreviews) {
        return
      }
      // Re-read the frame at render time: the queue is serial and the scene
      // hydration may have refreshed the frame while this job waited.
      renderQueue.enqueue(key, () => renderSceneToDataUrl(values.frames[frameId] ?? frame, sceneId))
    },
  })),
])
