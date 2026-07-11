// Typed wrapper around the FrameOS preview worker (assets/preview-worker.js).
// The worker loads the emscripten-built scene runtime (frameos.js/frameos.wasm)
// and drives renders; this class owns the worker lifecycle, paints frames onto
// a canvas, and exposes events/state as callbacks.
import type { FrameOSScene, PreviewFrame, SceneInfo } from './types'

export interface FrameOSPreviewOptions {
  /** URL of the module worker script: `<assets>/preview-worker.js`. The
   * frameos.js/frameos.wasm files must live next to it (same directory) —
   * copy the package's `dist/assets/` folder somewhere same-origin. */
  workerUrl: string | URL
  /** Render width/height in pixels (the frame's dimensions). */
  width: number
  height: number
  /** The scenes to load — the parsed contents of a scenes.json. */
  scenes: FrameOSScene[]
  /** Scene to select initially; defaults to the runtime's default scene. */
  sceneId?: string
  /** Frame name shown in logs. */
  name?: string
  /** IANA time zone for the simulated frame; defaults to the browser's. */
  timeZone?: string
  /** Frame settings (app API keys etc.); most previews run fine without. */
  settings?: Record<string, unknown>
  /** Same-origin proxy endpoint for the runtime's HTTP requests. Without it,
   * scenes fetching external data hit browser CORS limits. */
  proxyUrl?: string
  /** Canvas to paint frames onto; can also be attached later. */
  canvas?: HTMLCanvasElement | null
  onReady?: (sceneInfo: SceneInfo) => void
  onFrame?: (frame: PreviewFrame) => void
  onState?: (state: Record<string, unknown>) => void
  onLog?: (message: string) => void
  onSceneEvent?: (name: string, payload: Record<string, unknown>) => void
  onError?: (message: string) => void
}

interface PendingFrame {
  width: number
  height: number
  buffer: ArrayBuffer
}

export class FrameOSPreview {
  readonly options: FrameOSPreviewOptions
  private worker: Worker | null = null
  private canvas: HTMLCanvasElement | null = null
  private pendingFrame: PendingFrame | null = null
  private destroyed = false

  /** Latest scene info from the runtime (set once `ready` fires). */
  sceneInfo: SceneInfo | null = null
  /** Latest public state of the current scene. */
  state: Record<string, unknown> = {}
  /** The scene currently selected in the runtime. */
  currentSceneId: string | null = null

  constructor(options: FrameOSPreviewOptions) {
    this.options = options
    this.canvas = options.canvas ?? null
    this.currentSceneId = options.sceneId ?? null

    this.worker = new Worker(options.workerUrl, { type: 'module' })
    this.worker.onerror = (event: ErrorEvent) => {
      options.onError?.(event.message || 'FrameOS preview worker failed to load')
    }
    this.worker.onmessage = (event: MessageEvent) => this.handleMessage(event.data ?? {})
    this.worker.postMessage({
      type: 'init',
      width: options.width,
      height: options.height,
      name: options.name || 'frameos-wasm preview',
      timeZone: options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      scenesJson: JSON.stringify(options.scenes),
      settingsJson: JSON.stringify(options.settings ?? {}),
      proxyUrl: options.proxyUrl || '',
      sceneId: options.sceneId || '',
    })
  }

  private handleMessage(msg: Record<string, any>): void {
    if (this.destroyed) {
      return
    }
    switch (msg.type) {
      case 'ready':
        this.sceneInfo = msg.sceneInfo ?? null
        if (this.sceneInfo?.currentSceneId) {
          this.currentSceneId = this.sceneInfo.currentSceneId
        }
        this.options.onReady?.(msg.sceneInfo)
        break
      case 'frame':
        this.pendingFrame = { width: msg.width, height: msg.height, buffer: msg.buffer }
        this.paint()
        this.options.onFrame?.({ width: msg.width, height: msg.height, renderMs: msg.renderMs })
        break
      case 'state':
        this.state = msg.state ?? {}
        this.options.onState?.(this.state)
        break
      case 'log':
        this.options.onLog?.(String(msg.message ?? ''))
        break
      case 'sceneEvent':
        this.options.onSceneEvent?.(String(msg.name ?? ''), msg.payload ?? {})
        break
      case 'error':
        this.options.onError?.(String(msg.message ?? 'Unknown FrameOS preview error'))
        break
    }
  }

  /** Attach (or replace) the canvas frames are painted onto. */
  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
    this.paint()
  }

  private paint(): void {
    const canvas = this.canvas
    const frame = this.pendingFrame
    if (!canvas || !frame || !frame.buffer.byteLength) {
      return
    }
    if (canvas.width !== frame.width) {
      canvas.width = frame.width
    }
    if (canvas.height !== frame.height) {
      canvas.height = frame.height
    }
    const context = canvas.getContext('2d')
    if (!context) {
      return
    }
    context.putImageData(new ImageData(new Uint8ClampedArray(frame.buffer), frame.width, frame.height), 0, 0)
  }

  /** Force a render now. */
  render(): void {
    this.worker?.postMessage({ type: 'render' })
  }

  /** Dispatch a scene event (a custom event node's keyword, "button", ...). */
  sendEvent(name: string, payload: Record<string, unknown> = {}): void {
    this.worker?.postMessage({ type: 'event', name, payload })
  }

  /** Update the current scene's state fields; renders by default. */
  setSceneState(state: Record<string, unknown>, render = true): void {
    this.sendEvent('setSceneState', { state, render })
  }

  /** Switch the runtime to another loaded scene. */
  selectScene(sceneId: string): void {
    this.currentSceneId = sceneId
    this.worker?.postMessage({ type: 'selectScene', sceneId })
  }

  /** Terminate the worker; the instance cannot be reused afterwards. */
  destroy(): void {
    this.destroyed = true
    this.worker?.terminate()
    this.worker = null
    this.pendingFrame = null
    this.canvas = null
  }
}

export function createFrameOSPreview(options: FrameOSPreviewOptions): FrameOSPreview {
  return new FrameOSPreview(options)
}
