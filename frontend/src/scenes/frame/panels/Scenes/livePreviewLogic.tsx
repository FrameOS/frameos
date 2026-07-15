import { actions, beforeUnmount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { router } from 'kea-router'

import { FrameScene, GPIOButton, RepositoryType, TemplateType } from '../../../../types'
import { apiFetch } from '../../../../utils/apiFetch'
import { assetUrl } from '../../../../utils/assetUrl'
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

export interface LivePreviewLogLine {
  timestamp: string
  line: string
}

/** The template a preview was opened from, so the modal can offer "Add to frame". */
export interface LivePreviewSourceTemplate {
  template: TemplateType
  repository?: RepositoryType
}

const MAX_LOG_LINES = 200

// Apps that can't work in the browser preview: excluded from the wasm build
// (see frameos/src/apps/apps.nim — child processes, external binaries) or
// dependent on the frame's local filesystem.
const WASM_UNAVAILABLE_APPS: Record<string, string> = {
  'data/chromiumScreenshot': 'requires Playwright/Chromium',
  'data/rstpSnapshot': 'requires FFmpeg',
  'data/localImage': "reads images from the frame's local storage",
}

export interface WasmUnsupportedApp {
  keyword: string
  reason: string
}

// Hash param that keeps the in-browser preview open across reloads.
// ExpandedScene re-opens the preview on mount when it matches its scene.
export const LIVE_PREVIEW_HASH_KEY = 'livePreview'

function setLivePreviewHash(sceneId: string | null): void {
  const hashParams = { ...router.values.hashParams }
  if (sceneId === null) {
    if (!(LIVE_PREVIEW_HASH_KEY in hashParams)) {
      return
    }
    delete hashParams[LIVE_PREVIEW_HASH_KEY]
  } else {
    if (hashParams[LIVE_PREVIEW_HASH_KEY] === sceneId) {
      return
    }
    hashParams[LIVE_PREVIEW_HASH_KEY] = sceneId
  }
  router.actions.replace(router.values.location.pathname, router.values.searchParams, hashParams)
}

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
    openLivePreview: (
      sceneId: string,
      state?: Record<string, any> | null,
      scenes?: FrameScene[] | null,
      sourceTemplate?: LivePreviewSourceTemplate | null
    ) => ({
      sceneId,
      state: state ?? null,
      scenes: scenes ?? null,
      sourceTemplate: sourceTemplate ?? null,
    }),
    closeLivePreview: true,
    registerCanvas: (canvas: HTMLCanvasElement | null) => ({ canvas }),
    previewReady: true,
    previewFrame: (width: number, height: number, renderMs: number) => ({ width, height, renderMs }),
    previewErrored: (message: string) => ({ message }),
    appendPreviewLog: (message: string) => ({ message, timestamp: new Date().toISOString() }),
    setPreviewState: (state: Record<string, any>) => ({ state }),
    dispatchPreviewEvent: (name: string, payload: Record<string, any>) => ({ name, payload }),
    forcePreviewRender: true,
    setPreviewSettings: (settings: Record<string, Record<string, any>>) => ({ settings }),
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
      [] as LivePreviewLogLine[],
      {
        openLivePreview: () => [],
        appendPreviewLog: (state, { message, timestamp }) => [
          ...state.slice(-(MAX_LOG_LINES - 1)),
          { timestamp, line: message },
        ],
      },
    ],
    // Scenes passed explicitly to openLivePreview (e.g. template previews);
    // lets selectors resolve scene metadata for scenes not installed on the frame.
    livePreviewScenes: [
      null as FrameScene[] | null,
      {
        openLivePreview: (_, { scenes }) => scenes,
      },
    ],
    livePreviewSourceTemplate: [
      null as LivePreviewSourceTemplate | null,
      {
        openLivePreview: (_, { sourceTemplate }) => sourceTemplate,
        closeLivePreview: () => null,
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
    // User-entered app settings (API keys etc.) merged over the backend's
    // assembled settings on every (re)start. Kept in memory only — never
    // persisted or sent anywhere except into the wasm runtime.
    previewSettings: [
      {} as Record<string, Record<string, any>>,
      {
        setPreviewSettings: (_, { settings }) => settings,
      },
    ],
  }),
  selectors({
    livePreviewScene: [
      (s) => [s.livePreviewSceneId, s.livePreviewScenes, s.scenes],
      (livePreviewSceneId, livePreviewScenes, scenes): FrameScene | null =>
        livePreviewSceneId
          ? (livePreviewScenes ?? []).find((scene) => scene.id === livePreviewSceneId) ??
            scenes.find((scene) => scene.id === livePreviewSceneId) ??
            null
          : null,
    ],
    gpioButtons: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm): GPIOButton[] => frameForm?.gpio_buttons ?? frame?.gpio_buttons ?? [],
    ],
    // Apps used by the previewed scene (or any scene it references) that are
    // not compiled into the wasm bundle — surfaced as a notice in the modal.
    wasmUnsupportedApps: [
      (s) => [s.livePreviewSceneId, s.livePreviewScenes, s.scenes],
      (livePreviewSceneId, livePreviewScenes, scenes): WasmUnsupportedApp[] => {
        if (!livePreviewSceneId) {
          return []
        }
        const sceneList = livePreviewScenes && livePreviewScenes.length ? livePreviewScenes : scenes
        const rootScene = sceneList.find((scene) => scene.id === livePreviewSceneId)
        if (!rootScene) {
          return []
        }
        const found = new Map<string, string>()
        for (const scene of collectScenePreviewPayloadScenes(rootScene, sceneList, null)) {
          for (const node of scene.nodes ?? []) {
            const keyword = String((node.data as Record<string, any>)?.keyword ?? '')
            if (WASM_UNAVAILABLE_APPS[keyword]) {
              found.set(keyword, WASM_UNAVAILABLE_APPS[keyword])
            }
          }
        }
        return Array.from(found, ([keyword, reason]) => ({ keyword, reason }))
      },
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
    openLivePreview: async ({ sceneId, state, scenes }) => {
      cache.worker?.terminate()
      cache.worker = null
      cache.pendingFrame = null

      // An explicit `scenes` list lets callers preview scenes that aren't installed
      // on the frame yet (e.g. templates in the "add scene" panel); otherwise fall
      // back to the frame's own scenes.
      const sceneList = scenes && scenes.length ? scenes : values.scenes
      const scene = sceneList.find((item: FrameScene) => item.id === sceneId)
      if (!scene) {
        actions.previewErrored('Scene not found')
        return
      }

      // Persist in the URL hash so a reload reopens the preview. Only for the
      // frame's own scenes — template previews can't be restored after a
      // reload because their scenes aren't installed on the frame.
      if (!scenes) {
        setLivePreviewHash(sceneId)
      }

      // Seed the scene's public fields with the values the user entered in the
      // form so the in-browser preview reflects their input, not stored defaults.
      const payloadScenes = collectScenePreviewPayloadScenes(scene, sceneList, state ?? null)
      // Snapshot of the scenes as loaded (without state seeding), so
      // forcePreviewRender can tell whether they were edited since.
      cache.initialScenesJson = JSON.stringify(collectScenePreviewPayloadScenes(scene, sceneList, null))
      const { width, height } = values.previewDimensions

      const frameId = values.frame?.id ?? props.frameId

      // Fetch the frame's assembled settings (app API keys etc.) so data apps
      // that need secrets can run in the preview. Best-effort: a scene with no
      // secret-using apps still previews fine if this fails.
      let settings: Record<string, any> = {}
      try {
        const response = await apiFetch(`/api/frames/${frameId}/scene_preview_settings`)
        if (response.ok) {
          const data = await response.json()
          settings = data?.settings ?? {}
        }
      } catch (error) {
        // fall through with empty settings
      }
      // User-entered keys (setPreviewSettings) win over the backend's, merged
      // per settings group.
      for (const [group, groupValues] of Object.entries(values.previewSettings ?? {})) {
        settings[group] = { ...(settings[group] ?? {}), ...groupValues }
      }
      const settingsJson = JSON.stringify(settings)

      // Same-origin backend proxy so the runtime's HTTP requests (image apps,
      // weather, ...) work despite CORS — the worker's sync XHR carries auth
      // cookies to it. Resolve the project-prefixed absolute path up front.
      // An embedding page (the standalone editor bundle) can supply its own
      // proxy endpoint via FRAMEOS_APP_CONFIG.preview_proxy_url instead.
      let proxyUrl = ''
      const configuredProxyUrl = (window as any).FRAMEOS_APP_CONFIG?.preview_proxy_url
      if (typeof configuredProxyUrl === 'string' && configuredProxyUrl) {
        proxyUrl = configuredProxyUrl
      } else {
        try {
          proxyUrl = getBasePath() + (await projectApiPath(`/api/frames/${frameId}/scene_preview_proxy`))
        } catch (error) {
          // preview still runs; external fetches will fail with CORS as before
        }
      }

      let worker: Worker
      try {
        worker = new Worker(assetUrl('/frameos-wasm/preview-worker.js'), { type: 'module' })
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
      setLivePreviewHash(null)
    },
    registerCanvas: ({ canvas }) => {
      cache.canvas = canvas
      drawFrame(cache)
    },
    dispatchPreviewEvent: ({ name, payload }) => {
      cache.worker?.postMessage({ type: 'event', name, payload })
    },
    forcePreviewRender: () => {
      // The worker got a snapshot of the scenes when the preview opened; if
      // they were edited since (diagram, panels, ...), restart it on the
      // fresh scenes — carrying the current scene state over — instead of
      // re-rendering the stale snapshot.
      const sceneId = values.livePreviewSceneId
      if (sceneId && !values.livePreviewScenes && cache.initialScenesJson) {
        const scene = values.scenes.find((item: FrameScene) => item.id === sceneId)
        if (scene) {
          const currentScenesJson = JSON.stringify(collectScenePreviewPayloadScenes(scene, values.scenes, null))
          if (currentScenesJson !== cache.initialScenesJson) {
            actions.openLivePreview(sceneId, values.previewState)
            return
          }
        }
      }
      cache.worker?.postMessage({ type: 'render' })
    },
    setPreviewSettings: () => {
      // New keys only reach the runtime through its init message: restart the
      // running preview so they take effect.
      if (values.livePreviewSceneId) {
        actions.openLivePreview(values.livePreviewSceneId, values.previewState, values.livePreviewScenes)
      }
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
