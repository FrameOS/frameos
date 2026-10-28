import { collectScenePreviewPayloadScenes } from '../scenes/frame/panels/Scenes/scenesLogic'
import { fetchSettingsJson, previewProxyUrl } from '../models/wasmPreviewModel'
import { assetUrl } from './assetUrl'
import { wasmPreviewDimensions } from './wasmScenePreview'
import { describeOutOfMemory } from './deviceLimits'
import type { FrameRenderDevice } from './frameRenderDevice'
import type { FrameId, FrameScene } from '../types'

// Headless render check for AI-delivered scenes: run the scene once in the
// frameos-wasm worker (the same runtime the device runs) and collect what it
// logs, and the last frame it drew. The chat uses the result to feed runtime
// errors back to the AI agent for another pass — a scene that validates as
// JSON can still fail at render time (unsupported SVG, missing fields, app
// errors), and the device is too far away to tell us quickly — and shows the
// frame under the reply. On a frame with little memory (an ESP32) it renders
// under that frame's ceiling, so a scene that would run the device out of
// memory fails here first.

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
  /** Render under this device's memory and run as it (frameRenderDevice);
   * null renders with the browser's memory. */
  device?: FrameRenderDevice | null
}

export interface SceneRenderCheckResult {
  /** At least one frame was produced (errors may still have been logged). */
  rendered: boolean
  renderMs: number | null
  /** Log lines the runtime flagged as errors (logError, render failures). */
  errors: string[]
  /** All collected log lines, errors included, oldest first. */
  logs: string[]
  /** The preview runtime itself never started (no wasm build here, a
   * blocked worker): nothing was learned about the scene. */
  unavailable?: boolean
  /** The render ran out of the device's memory (`frame.device`); the
   * reason is in `errors`. */
  outOfMemory?: boolean
  /** The last frame drawn, as a PNG flattened onto white; null when nothing
   * was drawn or the browser cannot encode it. */
  image: { blob: Blob; width: number; height: number } | null
}

interface RawFrame {
  width: number
  height: number
  buffer: ArrayBuffer
}

function frameFromMessage(msg: { width?: unknown; height?: unknown; buffer?: unknown }): RawFrame | null {
  const { width, height, buffer } = msg
  if (typeof width !== 'number' || typeof height !== 'number' || !(buffer instanceof ArrayBuffer)) {
    return null
  }
  return buffer.byteLength === width * height * 4 && width > 0 && height > 0 ? { width, height, buffer } : null
}

// RGBA pixels → PNG, flattened onto white: the runtime can leave transparent
// pixels, and a transparent PNG shows the chat bubble (or the scene tile)
// through them.
async function framePng({ width, height, buffer }: RawFrame): Promise<Blob | null> {
  try {
    const pixels = document.createElement('canvas')
    pixels.width = width
    pixels.height = height
    const flattened = document.createElement('canvas')
    flattened.width = width
    flattened.height = height
    const pixelContext = pixels.getContext('2d')
    const context = flattened.getContext('2d')
    if (!pixelContext || !context) {
      return null
    }
    pixelContext.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(pixels, 0, 0)
    return await new Promise<Blob | null>((resolve) => flattened.toBlob(resolve, 'image/png'))
  } catch {
    return null
  }
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
    return { rendered: false, renderMs: null, errors: [`Scene ${sceneId} not found`], logs: [], image: null }
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
  let workerSpoke = false
  let unavailable = false
  let outOfMemory = false
  let lastFrame: RawFrame | null = null

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
      unavailable = !workerSpoke
      pushCapped(errors, event.message || 'Preview worker failed to load', MAX_COLLECTED_ERRORS)
      if (!rendered) {
        finish()
      }
    }
    worker.onmessage = (event: MessageEvent) => {
      workerSpoke = true
      const msg = event.data || {}
      if (msg.type === 'frame') {
        const firstFrame = !rendered
        rendered = true
        // Keep the newest frame: data apps often draw a placeholder first.
        lastFrame = frameFromMessage(msg) ?? lastFrame
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
      } else if (msg.type === 'outOfMemory' && frame.device) {
        // The worker stops rendering after this: it is what the device
        // would do (abort the render, then restart), so it is the answer.
        outOfMemory = true
        pushCapped(
          errors,
          describeOutOfMemory(
            { refusedBytes: Number(msg.refusedBytes) || 0, usedBytes: Number(msg.usedBytes) || 0 },
            frame.device.limits
          ),
          MAX_COLLECTED_ERRORS
        )
        finish()
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
      deviceLimits: frame.device?.limits ?? null,
      embedded: Boolean(frame.device?.limits.embedded),
    })
  })
  const drawn = lastFrame as RawFrame | null
  const blob = drawn ? await framePng(drawn) : null
  const image = drawn && blob ? { blob, width: drawn.width, height: drawn.height } : null
  return { rendered, renderMs, errors, logs, unavailable, outOfMemory, image }
}
