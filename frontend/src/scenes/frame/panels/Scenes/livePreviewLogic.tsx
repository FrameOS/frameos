import { actions, beforeUnmount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { FrameScene } from '../../../../types'
import { apiFetch } from '../../../../utils/apiFetch'
import { getBasePath } from '../../../../utils/getBasePath'
import { projectApiPath } from '../../../../utils/projectApi'
import { frameLogic } from '../../frameLogic'
import { collectScenePreviewPayloadScenes, scenesLogic } from './scenesLogic'

import type { livePreviewLogicType } from './livePreviewLogicType'

export interface LivePreviewLogicProps {
  frameId: number
}

export interface LivePreviewSceneEvent {
  keyword: string
  label: string | null
}

const MAX_LOG_LINES = 200

/** Events a scene reacts to on its own; not useful as interactive buttons. */
const LIFECYCLE_EVENTS = new Set(['render', 'init', 'open', 'close', 'setSceneState', 'setCurrentScene'])

export const livePreviewLogic = kea<livePreviewLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'livePreviewLogic']),
  props({} as LivePreviewLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: LivePreviewLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm'], scenesLogic({ frameId }), ['scenes']],
  })),
  actions({
    openLivePreview: (sceneId: string, state?: Record<string, any> | null) => ({ sceneId, state: state ?? null }),
    closeLivePreview: true,
    registerCanvas: (canvas: HTMLCanvasElement | null) => ({ canvas }),
    previewReady: true,
    previewFrame: (width: number, height: number, renderMs: number) => ({ width, height, renderMs }),
    previewErrored: (message: string) => ({ message }),
    appendPreviewLog: (message: string) => ({ message }),
    setPreviewState: (state: Record<string, any>) => ({ state }),
    dispatchPreviewEvent: (name: string, payload: Record<string, any>) => ({ name, payload }),
    forcePreviewRender: true,
  }),
  reducers({
    livePreviewSceneId: [
      null as string | null,
      {
        openLivePreview: (_, { sceneId }) => sceneId,
        closeLivePreview: () => null,
      },
    ],
    previewStatus: [
      'loading' as 'loading' | 'running' | 'error',
      {
        openLivePreview: () => 'loading',
        previewFrame: () => 'running',
        previewErrored: () => 'error',
      },
    ],
    previewError: [
      null as string | null,
      {
        openLivePreview: () => null,
        previewErrored: (_, { message }) => message,
      },
    ],
    previewLogs: [
      [] as string[],
      {
        openLivePreview: () => [],
        appendPreviewLog: (state, { message }) => [...state.slice(-(MAX_LOG_LINES - 1)), message],
      },
    ],
    previewState: [
      {} as Record<string, any>,
      {
        openLivePreview: () => ({}),
        setPreviewState: (_, { state }) => state,
      },
    ],
    lastRenderMs: [
      null as number | null,
      {
        openLivePreview: () => null,
        previewFrame: (_, { renderMs }) => renderMs,
      },
    ],
    renderCount: [
      0,
      {
        openLivePreview: () => 0,
        previewFrame: (state) => state + 1,
      },
    ],
  }),
  selectors({
    livePreviewScene: [
      (s) => [s.livePreviewSceneId, s.scenes],
      (livePreviewSceneId, scenes): FrameScene | null =>
        livePreviewSceneId ? (scenes.find((scene) => scene.id === livePreviewSceneId) ?? null) : null,
    ],
    previewDimensions: [
      (s) => [s.frame],
      (frame): { width: number; height: number } => {
        // The scene canvas has the rotated ("render") dimensions; the device
        // rotates the finished image afterwards.
        const width = frame?.width || 800
        const height = frame?.height || 480
        return frame?.rotate === 90 || frame?.rotate === 270 ? { width: height, height: width } : { width, height }
      },
    ],
    previewSceneEvents: [
      (s) => [s.livePreviewScene],
      (scene): LivePreviewSceneEvent[] => {
        if (!scene) {
          return []
        }
        const events: LivePreviewSceneEvent[] = []
        const seen = new Set<string>()
        for (const node of scene.nodes ?? []) {
          if (node.type !== 'event') {
            continue
          }
          const data = (node.data ?? {}) as Record<string, any>
          const keyword = String(data.keyword ?? '')
          if (!keyword || LIFECYCLE_EVENTS.has(keyword)) {
            continue
          }
          const label = data.config?.label ?? data.label ?? null
          const dedupeKey = `${keyword}:${label ?? ''}`
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey)
            events.push({ keyword, label: label ? String(label) : null })
          }
        }
        return events
      },
    ],
  }),
  listeners(({ actions, values, cache, props }) => ({
    openLivePreview: async ({ sceneId, state }) => {
      cache.worker?.terminate()
      cache.worker = null
      cache.pendingFrame = null

      const scene = values.scenes.find((item: FrameScene) => item.id === sceneId)
      if (!scene) {
        actions.previewErrored('Scene not found')
        return
      }

      // Seed the scene's public fields with the values the user entered in the
      // form so the in-browser preview reflects their input, not stored defaults.
      const payloadScenes = collectScenePreviewPayloadScenes(scene, values.scenes, state ?? null)
      const { width, height } = values.previewDimensions

      const frameId = values.frame?.id ?? props.frameId

      // Fetch the frame's assembled settings (app API keys etc.) so data apps
      // that need secrets can run in the preview. Best-effort: a scene with no
      // secret-using apps still previews fine if this fails.
      let settingsJson = '{}'
      try {
        const response = await apiFetch(`/api/frames/${frameId}/scene_preview_settings`)
        if (response.ok) {
          const data = await response.json()
          settingsJson = JSON.stringify(data?.settings ?? {})
        }
      } catch (error) {
        // fall through with empty settings
      }

      // Same-origin backend proxy so the runtime's HTTP requests (image apps,
      // weather, ...) work despite CORS — the worker's sync XHR carries auth
      // cookies to it. Resolve the project-prefixed absolute path up front.
      let proxyUrl = ''
      try {
        proxyUrl = getBasePath() + (await projectApiPath(`/api/frames/${frameId}/scene_preview_proxy`))
      } catch (error) {
        // preview still runs; external fetches will fail with CORS as before
      }

      let worker: Worker
      try {
        worker = new Worker('/frameos-wasm/preview-worker.js', { type: 'module' })
      } catch (error) {
        actions.previewErrored(
          'Could not start the live preview worker. Is the wasm bundle built? ' +
            'Run frameos/tools/build_wasm.sh (or the "wasm" mprocs pane) and reload.'
        )
        return
      }
      cache.worker = worker
      worker.onerror = (event) => {
        actions.previewErrored(
          event.message ||
            'Live preview worker failed to load. Is the wasm bundle built? ' +
              'Run frameos/tools/build_wasm.sh (or the "wasm" mprocs pane) and reload.'
        )
      }
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data || {}
        switch (msg.type) {
          case 'ready':
            actions.previewReady()
            break
          case 'frame': {
            cache.pendingFrame = msg
            drawFrame(cache)
            actions.previewFrame(msg.width, msg.height, msg.renderMs)
            break
          }
          case 'state':
            actions.setPreviewState(msg.state ?? {})
            break
          case 'log':
            actions.appendPreviewLog(String(msg.message ?? ''))
            break
          case 'sceneEvent':
            actions.appendPreviewLog(`event: ${msg.name} ${JSON.stringify(msg.payload ?? {})}`)
            break
          case 'error':
            actions.previewErrored(String(msg.message ?? 'Unknown live preview error'))
            break
          default:
            break
        }
      }

      worker.postMessage({
        type: 'init',
        width,
        height,
        name: values.frame?.name || 'live preview',
        timeZone:
          values.frameForm?.timezone ||
          values.frame?.timezone ||
          Intl.DateTimeFormat().resolvedOptions().timeZone ||
          'UTC',
        scenesJson: JSON.stringify(payloadScenes),
        settingsJson,
        proxyUrl,
        sceneId,
      })
    },
    closeLivePreview: () => {
      cache.worker?.terminate()
      cache.worker = null
      cache.pendingFrame = null
      cache.canvas = null
    },
    registerCanvas: ({ canvas }) => {
      cache.canvas = canvas
      drawFrame(cache)
    },
    dispatchPreviewEvent: ({ name, payload }) => {
      cache.worker?.postMessage({ type: 'event', name, payload })
    },
    forcePreviewRender: () => {
      cache.worker?.postMessage({ type: 'render' })
    },
  })),
  beforeUnmount(({ cache }) => {
    cache.worker?.terminate()
    cache.worker = null
  }),
])

/** Paint the latest worker frame onto the registered canvas. */
function drawFrame(cache: Record<string, any>): void {
  const canvas: HTMLCanvasElement | null = cache.canvas
  const frame = cache.pendingFrame
  if (!canvas || !frame || !frame.buffer) {
    return
  }
  const { width, height, buffer } = frame
  if (canvas.width !== width) {
    canvas.width = width
  }
  if (canvas.height !== height) {
    canvas.height = height
  }
  const context = canvas.getContext('2d')
  if (!context) {
    return
  }
  const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height)
  context.putImageData(imageData, 0, 0)
}
