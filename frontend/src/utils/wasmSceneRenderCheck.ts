import { collectScenePreviewPayloadScenes } from '../scenes/frame/panels/Scenes/scenesLogic'
import { fetchSettingsJson, previewProxyUrl } from '../models/wasmPreviewModel'
import { assetUrl } from './assetUrl'
import { wasmPreviewDimensions } from './wasmScenePreview'
import type { FrameId, FrameScene } from '../types'

// Headless render check for AI-delivered scenes: run the scene once in the
// frameos-wasm worker (the same runtime the device runs) and collect what it
// logs instead of what it draws. The chat uses the result to feed runtime
// errors back to the AI agent for another pass — a scene that validates as
// JSON can still fail at render time (unsupported SVG, missing fields, app
// errors), and the device is too far away to tell us quickly.

const RENDER_CHECK_SETTLE_MS = 2000
const RENDER_CHECK_TIMEOUT_MS = 30_000
const MAX_COLLECTED_LOGS = 100
const MAX_COLLECTED_ERRORS = 20

export interface SceneRenderCheckFrame {
  id: FrameId
  width?: number
  height?: number
  rotate?: number
  name?: string
  timezone?: string
}

export interface SceneRenderCheckResult {
  /** At least one frame was produced (errors may still have been logged). */
  rendered: boolean
  renderMs: number | null
  /** Log lines the runtime flagged as errors (logError, render failures). */
  errors: string[]
  /** All collected log lines, errors included, oldest first. */
  logs: string[]
}

function pushCapped(list: string[], entry: string, cap: number): void {
  list.push(entry)
  if (list.length > cap) {
    list.splice(0, list.length - cap)
  }
}

function formatLogPayload(message: string): { line: string; isError: boolean } {
  try {
    const payload = JSON.parse(message)
    if (payload && typeof payload === 'object') {
      const event = typeof payload.event === 'string' ? payload.event : ''
      const isError = event.startsWith('error') || typeof payload.error === 'string'
      return { line: message, isError }
    }
  } catch {
    // plain-text log line (http hook failures etc.)
  }
  return { line: message, isError: /\berror\b/i.test(message) }
}

/**
 * Renders `sceneId` from `scenes` once in a dedicated worker and resolves
 * with the collected logs. Never rejects: a crashed or hung worker resolves
 * as `rendered: false` with the failure in `errors`.
 */
export async function renderSceneCheck(
  frame: SceneRenderCheckFrame,
  scenes: FrameScene[],
  sceneId: string
): Promise<SceneRenderCheckResult> {
  const scene = scenes.find((item) => item.id === sceneId)
  if (!scene) {
    return { rendered: false, renderMs: null, errors: [`Scene ${sceneId} not found`], logs: [] }
  }
  const payloadScenes = collectScenePreviewPayloadScenes(scene, scenes, null)
  const { width, height } = wasmPreviewDimensions({
    width: frame.width,
    height: frame.height,
    rotate: frame.rotate,
  })
  const settingsJson = await fetchSettingsJson(frame.id)
  const proxyUrl = await previewProxyUrl(frame.id)

  const errors: string[] = []
  const logs: string[] = []
  let rendered = false
  let renderMs: number | null = null

  const worker = new Worker(assetUrl('/frameos-wasm/preview-worker.js'), { type: 'module' })
  await new Promise<void>((resolve) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settleTimer !== null) {
        clearTimeout(settleTimer)
      }
      clearTimeout(timeoutTimer)
      worker.terminate()
      resolve()
    }
    const timeoutTimer = setTimeout(() => {
      if (!rendered) {
        pushCapped(errors, 'Render check timed out: the scene produced no frame within 30s', MAX_COLLECTED_ERRORS)
      }
      finish()
    }, RENDER_CHECK_TIMEOUT_MS)
    worker.onerror = (event) => {
      pushCapped(errors, event.message || 'Preview worker failed to load', MAX_COLLECTED_ERRORS)
      if (!rendered) {
        finish()
      }
    }
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data || {}
      if (msg.type === 'frame') {
        const firstFrame = !rendered
        rendered = true
        renderMs = typeof msg.renderMs === 'number' ? msg.renderMs : renderMs
        if (firstFrame) {
          // Let immediate re-renders and async data apps settle so their
          // errors are collected too.
          settleTimer = setTimeout(finish, RENDER_CHECK_SETTLE_MS)
        }
      } else if (msg.type === 'log' && typeof msg.message === 'string') {
        const { line, isError } = formatLogPayload(msg.message)
        pushCapped(logs, line, MAX_COLLECTED_LOGS)
        if (isError) {
          pushCapped(errors, line, MAX_COLLECTED_ERRORS)
        }
      } else if (msg.type === 'error') {
        pushCapped(errors, String(msg.message ?? 'Render failed'), MAX_COLLECTED_ERRORS)
        if (!rendered) {
          finish()
        }
      }
    }
    worker.postMessage({
      type: 'init',
      width,
      height,
      name: frame.name || 'render check',
      timeZone: frame.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      scenesJson: JSON.stringify(payloadScenes),
      settingsJson,
      proxyUrl,
      sceneId: scene.id,
    })
  })
  return { rendered, renderMs, errors, logs }
}
