import {
  MakeLogicType,
  actions,
  beforeUnmount,
  connect,
  kea,
  key,
  listeners,
  path,
  props,
  reducers,
  selectors,
} from 'kea'
import { router } from 'kea-router'

import { FrameScene, GPIOButton, RepositoryType, TemplateType, FrameId } from '../../../../types'
import { apiFetch } from '../../../../utils/apiFetch'
import { assetUrl } from '../../../../utils/assetUrl'
import { isCloudMode } from '../../../../utils/cloudMode'
import { isFrameControlMode } from '../../../../utils/frameControlMode'
import { getBasePath } from '../../../../utils/getBasePath'
import { projectApiPath } from '../../../../utils/projectApi'
import { frameLogic } from '../../frameLogic'
import { collectScenePreviewPayloadScenes, scenesLogic } from './scenesLogic'
import type { FrameType } from '../../../../types'

export interface LivePreviewLogicProps {
  frameId: FrameId
}

export interface LivePreviewSceneEvent {
  keyword: string
  label: string | null
}

export interface LivePreviewLogLine {
  /** Stable per line, so the log list can skip re-rendering old rows. */
  id: number
  timestamp: string
  line: string
}

/** The template a preview was opened from, so the modal can offer "Add to frame". */
export interface LivePreviewSourceTemplate {
  template: TemplateType
  repository?: RepositoryType
}

const MAX_LOG_LINES = 200
// A scene rendering at full speed reports frames, state and log lines many
// times a second; the page batches them so React work stays bounded. The
// first item after a quiet spell goes through at once (leading edge).
const UI_FLUSH_INTERVAL_MS = 200
let nextLogLineId = 1

// Apps that can't work in the browser preview: excluded from the wasm build
// (see frameos/src/apps/apps.nim — child processes, external binaries).
// data/localImage works: it reads the browser asset folder (see
// BrowserAssetsModal) mounted at the frame's /srv/assets path.
const WASM_UNAVAILABLE_APPS: Record<string, string> = {
  'data/chromiumScreenshot': 'requires Playwright/Chromium',
  'data/rstpSnapshot': 'requires FFmpeg',
}

/** One entry of the browser asset folder (the worker's /srv/assets). */
export interface PreviewAssetEntry {
  /** Relative to the folder root, e.g. `photos/beach.jpg`. */
  path: string
  size: number
  mtime: number
  isDir: boolean
}

/** How the worker backs /srv/assets (from its `ready` / `list` replies). */
export interface PreviewAssetsInfo {
  mounted: boolean
  /** Kept in IndexedDB between previews, or in memory for this worker only. */
  persistent: boolean
  root: string
  maxBytes: number
}

/** The scene asked to render every `intervalMs` — faster than the 1 fps throttle. */
export interface FastRenderRequest {
  intervalMs: number
  /** The user accepted or declined; the banner is gone, the toggle stays. */
  answered: boolean
}

/**
 * Bytes of one file in the running preview's browser asset folder, for
 * thumbnails. Rejects when no preview runs for the frame.
 */
export function readPreviewAsset(frameId: FrameId, path: string): Promise<ArrayBuffer> {
  const logic = livePreviewLogic.findMounted({ frameId })
  const request = logic?.cache.assetRequest as PreviewAssetRequest | undefined
  if (!request) {
    return Promise.reject(new Error('preview is not running'))
  }
  return request('read', { path }).then((result) => result.data as ArrayBuffer)
}

type PreviewAssetRequest = (
  op: string,
  params?: Record<string, unknown>,
  transfer?: Transferable[]
) => Promise<Record<string, any>>

/**
 * Request/reply plumbing for the worker's browser asset folder ops: every
 * request carries an id, the worker answers with an `assetsResult` for it.
 */
function createAssetRequester(worker: Worker): {
  request: PreviewAssetRequest
  resolve: (msg: Record<string, any>) => void
  rejectAll: () => void
} {
  const pending = new Map<number, { resolve: (msg: Record<string, any>) => void; reject: (error: Error) => void }>()
  let nextId = 1
  return {
    request: (op, params = {}, transfer = []) =>
      new Promise((resolve, reject) => {
        const requestId = nextId++
        pending.set(requestId, { resolve, reject })
        worker.postMessage({ type: 'assets', requestId, op, ...params }, transfer)
      }),
    resolve: (msg) => {
      const entry = pending.get(msg.requestId)
      if (!entry) {
        return
      }
      pending.delete(msg.requestId)
      if (msg.ok) {
        entry.resolve(msg)
      } else {
        entry.reject(new Error(String(msg.error ?? 'asset request failed')))
      }
    },
    rejectAll: () => {
      for (const entry of pending.values()) {
        entry.reject(new Error('preview stopped'))
      }
      pending.clear()
    },
  }
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

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface livePreviewLogicValues {
  frame: FrameType // frameLogic
  frameForm: Partial<FrameType> // frameLogic
  scenes: FrameScene[] // scenesLogic
  fastMode: boolean
  fastRenderRequest: FastRenderRequest | null
  gpioButtons: GPIOButton[]
  lastRenderMs: number | null
  livePreviewScene: FrameScene | null
  livePreviewSceneId: string | null
  livePreviewScenes: FrameScene[] | null
  livePreviewSourceTemplate: LivePreviewSourceTemplate | null
  previewAssets: PreviewAssetEntry[]
  previewAssetsError: string | null
  previewAssetsInfo: PreviewAssetsInfo | null
  previewAssetsLoading: boolean
  previewAssetsOpen: boolean
  previewDimensions: {
    height: number
    width: number
  }
  previewError: string | null
  previewLogs: LivePreviewLogLine[]
  previewSceneEvents: LivePreviewSceneEvent[]
  previewSettings: Record<string, Record<string, any>>
  previewState: Record<string, any>
  previewStatus: 'error' | 'loading' | 'running'
  renderCount: number
  wasmUnsupportedApps: WasmUnsupportedApp[]
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface livePreviewLogicActions {
  appendPreviewLog: (message: string) => {
    message: string
    timestamp: string
  }
  appendPreviewLogs: (lines: LivePreviewLogLine[]) => {
    lines: LivePreviewLogLine[]
  }
  closeLivePreview: () => {
    value: true
  }
  closePreviewAssets: () => {
    value: true
  }
  createPreviewAssetFolder: (path: string) => {
    path: string
  }
  deletePreviewAsset: (path: string) => {
    path: string
  }
  dismissFastRenderRequest: () => {
    value: true
  }
  dispatchPreviewEvent: (
    name: string,
    payload: Record<string, any>
  ) => {
    name: string
    payload: Record<string, any>
  }
  fastRenderRequested: (intervalMs: number) => {
    intervalMs: number
  }
  forcePreviewRender: () => {
    value: true
  }
  loadPreviewAssets: () => {
    value: true
  }
  openLivePreview: (
    sceneId: string,
    state?: Record<string, any> | null,
    scenes?: FrameScene[] | null,
    sourceTemplate?: LivePreviewSourceTemplate | null
  ) => {
    sceneId: string
    scenes: FrameScene[] | null
    sourceTemplate: LivePreviewSourceTemplate | null
    state: Record<string, any> | null
  }
  openPreviewAssets: () => {
    value: true
  }
  previewAssetsChanged: () => {
    value: true
  }
  previewAssetsFailed: (error: string) => {
    error: string
  }
  previewAssetsLoaded: (
    entries: PreviewAssetEntry[],
    info: PreviewAssetsInfo | null
  ) => {
    entries: PreviewAssetEntry[]
    info: PreviewAssetsInfo | null
  }
  previewErrored: (message: string) => {
    message: string
  }
  previewFrame: (
    width: number,
    height: number,
    renderMs: number,
    count?: number
  ) => {
    count: number
    height: number
    renderMs: number
    width: number
  }
  previewReady: () => {
    value: true
  }
  registerCanvas: (canvas: HTMLCanvasElement | null) => {
    canvas: HTMLCanvasElement | null
  }
  resetFastRender: () => {
    value: true
  }
  resetPreviewAssets: () => {
    value: true
  }
  setFastMode: (enabled: boolean) => {
    enabled: boolean
  }
  setPreviewSettings: (settings: Record<string, Record<string, any>>) => {
    settings: Record<string, Record<string, any>>
  }
  setPreviewState: (state: Record<string, any>) => {
    state: Record<string, any>
  }
  uploadPreviewAssets: (
    folder: string,
    files: File[]
  ) => {
    files: File[]
    folder: string
  }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface livePreviewLogicMeta {
  key: FrameId
  __keaTypeGenInternalSelectorTypes: {
    livePreviewScene: (
      livePreviewSceneId: string | null,
      livePreviewScenes: FrameScene[] | null,
      scenes: FrameScene[]
    ) => FrameScene | null
    gpioButtons: (frame: FrameType, frameForm: Partial<FrameType>) => GPIOButton[]
    wasmUnsupportedApps: (
      livePreviewSceneId: string | null,
      livePreviewScenes: FrameScene[] | null,
      scenes: FrameScene[]
    ) => WasmUnsupportedApp[]
    previewDimensions: (frame: FrameType) => {
      height: number
      width: number
    }
    previewSceneEvents: (livePreviewScene: FrameScene | null) => LivePreviewSceneEvent[]
  }
}

export type livePreviewLogicType = MakeLogicType<
  livePreviewLogicValues,
  livePreviewLogicActions,
  LivePreviewLogicProps
> &
  livePreviewLogicMeta

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
    // `count` frames arrived since the last report (the page coalesces).
    previewFrame: (width: number, height: number, renderMs: number, count: number = 1) => ({
      width,
      height,
      renderMs,
      count,
    }),
    previewErrored: (message: string) => ({ message }),
    appendPreviewLog: (message: string) => ({ message, timestamp: new Date().toISOString() }),
    appendPreviewLogs: (lines: LivePreviewLogLine[]) => ({ lines }),
    setPreviewState: (state: Record<string, any>) => ({ state }),
    dispatchPreviewEvent: (name: string, payload: Record<string, any>) => ({ name, payload }),
    forcePreviewRender: true,
    setPreviewSettings: (settings: Record<string, Record<string, any>>) => ({ settings }),
    // Render pacing: the worker throttles to 1 fps and asks before going faster.
    fastRenderRequested: (intervalMs: number) => ({ intervalMs }),
    dismissFastRenderRequest: true,
    setFastMode: (enabled: boolean) => ({ enabled }),
    resetFastRender: true,
    // The browser asset folder (the worker's /srv/assets, kept in IndexedDB).
    openPreviewAssets: true,
    closePreviewAssets: true,
    loadPreviewAssets: true,
    previewAssetsLoaded: (entries: PreviewAssetEntry[], info: PreviewAssetsInfo | null) => ({ entries, info }),
    previewAssetsFailed: (error: string) => ({ error }),
    previewAssetsChanged: true,
    uploadPreviewAssets: (folder: string, files: File[]) => ({ folder, files }),
    createPreviewAssetFolder: (path: string) => ({ path }),
    deletePreviewAsset: (path: string) => ({ path }),
    resetPreviewAssets: true,
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
          { id: nextLogLineId++, timestamp, line: message },
        ],
        appendPreviewLogs: (state, { lines }) => [...state, ...lines].slice(-MAX_LOG_LINES),
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
        previewFrame: (state, { count }) => state + count,
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
    // Whether the worker may render faster than once a second. Survives
    // restarts of the same scene (state edits, new keys); a different scene
    // starts throttled again.
    fastMode: [
      false,
      {
        setFastMode: (_, { enabled }) => enabled,
        resetFastRender: () => false,
        closeLivePreview: () => false,
      },
    ],
    fastRenderRequest: [
      null as FastRenderRequest | null,
      {
        fastRenderRequested: (state, { intervalMs }) => ({ intervalMs, answered: state?.answered ?? false }),
        dismissFastRenderRequest: (state) => (state ? { ...state, answered: true } : state),
        setFastMode: (state) => (state ? { ...state, answered: true } : state),
        resetFastRender: () => null,
        closeLivePreview: () => null,
      },
    ],
    previewAssetsOpen: [
      false,
      {
        openPreviewAssets: () => true,
        closePreviewAssets: () => false,
        closeLivePreview: () => false,
      },
    ],
    previewAssets: [
      [] as PreviewAssetEntry[],
      {
        previewAssetsLoaded: (_, { entries }) => entries,
      },
    ],
    previewAssetsInfo: [
      null as PreviewAssetsInfo | null,
      {
        previewAssetsLoaded: (state, { info }) => info ?? state,
        openLivePreview: () => null,
      },
    ],
    previewAssetsLoading: [
      false,
      {
        loadPreviewAssets: () => true,
        previewAssetsLoaded: () => false,
        previewAssetsFailed: () => false,
      },
    ],
    previewAssetsError: [
      null as string | null,
      {
        loadPreviewAssets: () => null,
        previewAssetsFailed: (_, { error }) => error,
        openPreviewAssets: () => null,
      },
    ],
  }),
  selectors({
    livePreviewScene: [
      (s) => [s.livePreviewSceneId, s.livePreviewScenes, s.scenes],
      (
        livePreviewSceneId: livePreviewLogicValues['livePreviewSceneId'],
        livePreviewScenes: livePreviewLogicValues['livePreviewScenes'],
        scenes: livePreviewLogicValues['scenes']
      ): FrameScene | null =>
        livePreviewSceneId
          ? (livePreviewScenes ?? []).find((scene) => scene.id === livePreviewSceneId) ??
            scenes.find((scene) => scene.id === livePreviewSceneId) ??
            null
          : null,
    ],
    gpioButtons: [
      (s) => [s.frame, s.frameForm],
      (frame: livePreviewLogicValues['frame'], frameForm: livePreviewLogicValues['frameForm']): GPIOButton[] =>
        frameForm?.gpio_buttons ?? frame?.gpio_buttons ?? [],
    ],
    // Apps used by the previewed scene (or any scene it references) that are
    // not compiled into the wasm bundle — surfaced as a notice in the modal.
    wasmUnsupportedApps: [
      (s) => [s.livePreviewSceneId, s.livePreviewScenes, s.scenes],
      (
        livePreviewSceneId: livePreviewLogicValues['livePreviewSceneId'],
        livePreviewScenes: livePreviewLogicValues['livePreviewScenes'],
        scenes: livePreviewLogicValues['scenes']
      ): WasmUnsupportedApp[] => {
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
      (frame: livePreviewLogicValues['frame']): { width: number; height: number } => {
        // The scene canvas has the rotated ("render") dimensions; the device
        // rotates the finished image afterwards.
        const width = frame?.width || 800
        const height = frame?.height || 480
        return frame?.rotate === 90 || frame?.rotate === 270 ? { width: height, height: width } : { width, height }
      },
    ],
    previewSceneEvents: [
      (s) => [s.livePreviewScene],
      (scene: livePreviewLogicValues['livePreviewScene']): LivePreviewSceneEvent[] => {
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
      cache.assetRequester?.rejectAll()
      cache.assetRequester = null
      cache.assetRequest = null
      clearUiFlushes(cache)
      // A different scene starts throttled again; a restart of the same one
      // (state edits, new keys) keeps the user's fast-mode answer.
      if (cache.lastOpenedSceneId !== sceneId) {
        actions.resetFastRender()
      }
      cache.lastOpenedSceneId = sceneId

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

      // Fetch the stored settings (app API keys etc.) so data apps that need
      // secrets can run in the preview. Best-effort: a scene with no
      // secret-using apps still previews fine if this fails. On the cloud
      // GET /api/settings already answers with the merged {group: value}
      // object; the backend assembles the same shape per frame.
      let settings: Record<string, any> = {}
      try {
        if (isCloudMode()) {
          const response = await apiFetch(`/api/settings`)
          if (response.ok) {
            settings = (await response.json()) ?? {}
          }
        } else {
          const response = await apiFetch(`/api/frames/${frameId}/scene_preview_settings`)
          if (response.ok) {
            const data = await response.json()
            settings = data?.settings ?? {}
          }
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

      // Same-origin proxy so the runtime's HTTP requests (image apps,
      // weather, ...) work despite CORS — the worker's sync XHR carries auth
      // cookies to it. Resolve the project-prefixed absolute path up front.
      // An embedding page (the standalone editor bundle) can supply its own
      // proxy endpoint via FRAMEOS_APP_CONFIG.preview_proxy_url instead.
      let proxyUrl = ''
      const configuredProxyUrl = (window as any).FRAMEOS_APP_CONFIG?.preview_proxy_url
      if (typeof configuredProxyUrl === 'string' && configuredProxyUrl) {
        proxyUrl = configuredProxyUrl
      } else if (isCloudMode()) {
        // The cloud has no project-scoped backend proxy; it serves the same
        // anonymous, rate-limited proxy the store's preview pages use. Also
        // the fallback for a shell served without injected app config.
        proxyUrl = getBasePath() + '/api/store/preview-proxy'
      } else if (isFrameControlMode()) {
        // The frame's own web server has no proxy endpoint — leave the
        // preview direct-only rather than probing routes that don't exist.
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
      const assetRequester = createAssetRequester(worker)
      cache.assetRequester = assetRequester
      cache.assetRequest = assetRequester.request
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
            // Paint at once; report to the store in batches (see UI_FLUSH_INTERVAL_MS).
            cache.pendingFrame = msg
            drawFrame(cache)
            const stats = cache.frameStats ?? { width: 0, height: 0, renderMs: 0, count: 0 }
            cache.frameStats = { width: msg.width, height: msg.height, renderMs: msg.renderMs, count: stats.count + 1 }
            scheduleUiFlush(cache, 'frame', () => {
              const flushed = cache.frameStats
              cache.frameStats = null
              if (flushed) {
                actions.previewFrame(flushed.width, flushed.height, flushed.renderMs, flushed.count)
              }
            })
            break
          }
          case 'state':
            actions.setPreviewState(msg.state ?? {})
            break
          case 'log':
            queuePreviewLog(cache, String(msg.message ?? ''), (lines) => actions.appendPreviewLogs(lines))
            break
          case 'sceneEvent':
            queuePreviewLog(cache, `event: ${msg.name} ${JSON.stringify(msg.payload ?? {})}`, (lines) =>
              actions.appendPreviewLogs(lines)
            )
            break
          case 'error':
            actions.previewErrored(String(msg.message ?? 'Unknown live preview error'))
            break
          case 'fastRenderRequest':
            actions.fastRenderRequested(Number(msg.intervalMs) || 0)
            break
          case 'assetsChanged':
            actions.previewAssetsChanged()
            break
          case 'assetsResult':
            assetRequester.resolve(msg)
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
        fastMode: values.fastMode,
        // Apps may save into the browser folder; it is the user's own
        // browser storage, so the frame's saveAssets setting doesn't apply.
        saveAssets: true,
      })
    },
    closeLivePreview: () => {
      cache.worker?.terminate()
      cache.worker = null
      cache.pendingFrame = null
      cache.canvas = null
      clearUiFlushes(cache)
      cache.assetRequester?.rejectAll()
      cache.assetRequester = null
      cache.assetRequest = null
      cache.lastOpenedSceneId = null
      setLivePreviewHash(null)
    },
    setFastMode: ({ enabled }) => {
      cache.worker?.postMessage({ type: 'setFastMode', enabled })
    },
    openPreviewAssets: () => {
      actions.loadPreviewAssets()
    },
    previewAssetsChanged: () => {
      if (values.previewAssetsOpen) {
        actions.loadPreviewAssets()
      }
    },
    // No breakpoint: reloads overlap (an upload's reload racing the worker's
    // assetsChanged), every listing is complete, and the last one wins.
    loadPreviewAssets: async () => {
      const request = cache.assetRequest as PreviewAssetRequest | null
      if (!request) {
        actions.previewAssetsFailed('The preview is not running — start it to manage its browser assets.')
        return
      }
      try {
        const result = await request('list')
        actions.previewAssetsLoaded((result.entries ?? []) as PreviewAssetEntry[], result.info ?? null)
      } catch (error) {
        actions.previewAssetsFailed(error instanceof Error ? error.message : String(error))
      }
    },
    uploadPreviewAssets: async ({ folder, files }) => {
      const request = cache.assetRequest as PreviewAssetRequest | null
      if (!request) {
        return
      }
      for (const file of files) {
        const path = folder ? `${folder}/${file.name}` : file.name
        try {
          const data = await file.arrayBuffer()
          await request('write', { path, data }, [data])
        } catch (error) {
          actions.previewAssetsFailed(
            `Could not add ${file.name}: ${error instanceof Error ? error.message : String(error)}`
          )
          return
        }
      }
      actions.loadPreviewAssets()
    },
    createPreviewAssetFolder: async ({ path }) => {
      const request = cache.assetRequest as PreviewAssetRequest | null
      if (!request) {
        return
      }
      try {
        await request('mkdir', { path })
        actions.loadPreviewAssets()
      } catch (error) {
        actions.previewAssetsFailed(error instanceof Error ? error.message : String(error))
      }
    },
    deletePreviewAsset: async ({ path }) => {
      const request = cache.assetRequest as PreviewAssetRequest | null
      if (!request) {
        return
      }
      try {
        await request('delete', { path })
        actions.loadPreviewAssets()
      } catch (error) {
        actions.previewAssetsFailed(error instanceof Error ? error.message : String(error))
      }
    },
    resetPreviewAssets: async () => {
      const request = cache.assetRequest as PreviewAssetRequest | null
      if (!request) {
        return
      }
      try {
        await request('reset')
        actions.loadPreviewAssets()
      } catch (error) {
        actions.previewAssetsFailed(error instanceof Error ? error.message : String(error))
      }
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
    clearUiFlushes(cache)
    cache.assetRequester?.rejectAll()
    cache.assetRequester = null
    cache.assetRequest = null
  }),
])

/**
 * Leading-edge throttle per key: the first call after a quiet spell runs
 * now, further calls within UI_FLUSH_INTERVAL_MS collapse into one trailing
 * run. Timers live in the logic's cache so a restart can drop them.
 */
function scheduleUiFlush(cache: Record<string, any>, key: string, flush: () => void): void {
  const flushes: Record<string, { timer: ReturnType<typeof setTimeout> | null; lastAt: number }> = (cache.uiFlushes ??=
    {})
  const entry = (flushes[key] ??= { timer: null, lastAt: 0 })
  if (entry.timer !== null) {
    return
  }
  const elapsed = Date.now() - entry.lastAt
  if (elapsed >= UI_FLUSH_INTERVAL_MS) {
    entry.lastAt = Date.now()
    flush()
    return
  }
  entry.timer = setTimeout(() => {
    entry.timer = null
    entry.lastAt = Date.now()
    flush()
  }, UI_FLUSH_INTERVAL_MS - elapsed)
}

function clearUiFlushes(cache: Record<string, any>): void {
  for (const entry of Object.values(
    (cache.uiFlushes ?? {}) as Record<string, { timer: ReturnType<typeof setTimeout> | null }>
  )) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }
  cache.uiFlushes = {}
  cache.frameStats = null
  cache.logQueue = []
}

function queuePreviewLog(
  cache: Record<string, any>,
  line: string,
  append: (lines: LivePreviewLogLine[]) => void
): void {
  const queue: LivePreviewLogLine[] = (cache.logQueue ??= [])
  queue.push({ id: nextLogLineId++, timestamp: new Date().toISOString(), line })
  scheduleUiFlush(cache, 'log', () => {
    const lines = cache.logQueue ?? []
    cache.logQueue = []
    if (lines.length > 0) {
      append(lines)
    }
  })
}

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
