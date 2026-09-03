// Typed wrapper around the FrameOS preview worker (assets/preview-worker.js).
// The worker loads the emscripten-built scene runtime (frameos.js/frameos.wasm)
// and drives renders; this class owns the worker lifecycle, paints frames onto
// a canvas, and exposes events/state as callbacks.
import type { DeviceLimits } from './devices'
import { ditherFrame, panelPaletteFor, type PanelPaletteKey } from './dither'
import type {
  FrameOSScene,
  PreviewAssetEntry,
  PreviewAssetsInfo,
  PreviewFrame,
  PreviewRuntimeInfo,
  SceneInfo,
} from './types'

/** What a render cost under a simulated device ceiling. */
export interface DeviceMemoryUsage {
  limitBytes: number
  usedBytes: number
  peakBytes: number
}

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
  /** Renders are throttled to one per second unless this is true (see
   * `onFastRenderRequest` and `setFastMode`). */
  fastMode?: boolean
  /** Whether apps may save files into the browser asset folder — a frame's
   * `saveAssets` setting: a boolean, or `{nodeName: boolean}`. Defaults to
   * true (it is the visitor's own browser storage). */
  saveAssets?: boolean | Record<string, boolean>
  /** Set to false to run with an empty in-memory /srv/assets instead of the
   * browser's persistent folder. */
  browserAssets?: boolean
  /** Run under a device's memory ceiling, so a scene too heavy for that
   * device fails here instead of on hardware (see ./devices). Null or
   * omitted renders with the browser's own memory. */
  deviceLimits?: DeviceLimits | null
  /** Show frames the way an e-ink panel would: dithered to that panel's
   * inks or greys (see ./dither). Display only — the scene renders in full
   * colour either way. Null (the default) paints the frame as rendered. */
  panelPalette?: PanelPaletteKey | null
  onReady?: (sceneInfo: SceneInfo, assets: PreviewAssetsInfo | null, runtime: PreviewRuntimeInfo) => void
  onFrame?: (frame: PreviewFrame) => void
  onState?: (state: Record<string, unknown>) => void
  onLog?: (message: string) => void
  onSceneEvent?: (name: string, payload: Record<string, unknown>) => void
  onError?: (message: string) => void
  /** The render ran out of memory under the simulated device ceiling. The
   * runtime's heap is not recoverable afterwards (the same longjmp-and-reboot
   * the firmware does), so the preview stops until it is re-created. */
  onOutOfMemory?: (info: DeviceMemoryUsage & { refusedBytes: number }) => void
  /** Memory used by the last render, while a device is simulated. */
  onMemory?: (usage: DeviceMemoryUsage) => void
  /** The scene asked to render every `intervalMs` — faster than the 1 fps
   * throttle. Fires once per runtime start; call `setFastMode(true)` to let
   * the scene run at its own pace. */
  onFastRenderRequest?: (intervalMs: number) => void
  /** Files in the browser asset folder changed: the scene saved something,
   * or an asset op completed. */
  onAssetsChanged?: () => void
}

interface PendingFrame {
  width: number
  height: number
  buffer: ArrayBuffer
}

interface PendingAssetRequest {
  resolve: (result: Record<string, any>) => void
  reject: (error: Error) => void
}

export class FrameOSPreview {
  readonly options: FrameOSPreviewOptions
  private worker: Worker | null = null
  private canvas: HTMLCanvasElement | null = null
  private pendingFrame: PendingFrame | null = null
  private destroyed = false
  private assetRequests = new Map<number, PendingAssetRequest>()
  private nextAssetRequestId = 1

  /** Latest scene info from the runtime (set once `ready` fires). */
  sceneInfo: SceneInfo | null = null
  /** How the runtime's /srv/assets is backed (set once `ready` fires). */
  assetsInfo: PreviewAssetsInfo | null = null
  /** Which FrameOS version the runtime is (set once `ready` fires). */
  runtimeInfo: PreviewRuntimeInfo = { version: null }
  /** Latest public state of the current scene. */
  state: Record<string, unknown> = {}
  /** The scene currently selected in the runtime. */
  currentSceneId: string | null = null
  /** Whether renders may run faster than once per second. */
  fastMode: boolean
  /** The panel frames are shown through, or null for the true colours. */
  panelPalette: PanelPaletteKey | null

  constructor(options: FrameOSPreviewOptions) {
    this.options = options
    this.canvas = options.canvas ?? null
    this.currentSceneId = options.sceneId ?? null
    this.fastMode = Boolean(options.fastMode)
    this.panelPalette = options.panelPalette ?? null

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
      fastMode: this.fastMode,
      saveAssets: options.saveAssets === undefined ? true : options.saveAssets,
      browserAssets: options.browserAssets === undefined ? true : options.browserAssets,
      deviceLimits: options.deviceLimits ?? null,
    })
  }

  private handleMessage(msg: Record<string, any>): void {
    if (this.destroyed) {
      return
    }
    switch (msg.type) {
      case 'ready':
        this.sceneInfo = msg.sceneInfo ?? null
        this.assetsInfo = msg.browserAssets ?? null
        if (this.sceneInfo?.currentSceneId) {
          this.currentSceneId = this.sceneInfo.currentSceneId
        }
        this.runtimeInfo = { version: typeof msg.runtimeVersion === 'string' ? msg.runtimeVersion : null }
        this.options.onReady?.(msg.sceneInfo, this.assetsInfo, this.runtimeInfo)
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
      case 'memory':
        this.options.onMemory?.({
          limitBytes: Number(msg.limitBytes ?? 0),
          usedBytes: Number(msg.usedBytes ?? 0),
          peakBytes: Number(msg.peakBytes ?? 0),
        })
        break

      case 'outOfMemory':
        this.options.onOutOfMemory?.({
          limitBytes: Number(msg.limitBytes ?? 0),
          usedBytes: Number(msg.usedBytes ?? 0),
          peakBytes: Number(msg.peakBytes ?? 0),
          refusedBytes: Number(msg.refusedBytes ?? 0),
        })
        break

      case 'error':
        this.options.onError?.(String(msg.message ?? 'Unknown FrameOS preview error'))
        break
      case 'fastRenderRequest':
        this.options.onFastRenderRequest?.(Number(msg.intervalMs) || 0)
        break
      case 'assetsChanged':
        this.options.onAssetsChanged?.()
        break
      case 'assetsResult': {
        const pending = this.assetRequests.get(msg.requestId)
        if (!pending) {
          break
        }
        this.assetRequests.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve(msg)
        } else {
          pending.reject(new Error(String(msg.error ?? 'asset request failed')))
        }
        break
      }
    }
  }

  /** Attach (or replace) the canvas frames are painted onto. */
  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
    this.paint()
  }

  /** Show frames through a panel's palette (or null for true colour), and
   * repaint the frame already on screen — no re-render needed, the picture
   * is the same one. */
  setPanelPalette(palette: PanelPaletteKey | null): void {
    this.panelPalette = palette
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
    const panel = panelPaletteFor(this.panelPalette)
    // A view over the frame buffer when painting it as rendered; a copy when
    // dithering, so the kept frame stays full colour and switching panels
    // (or repainting on attach) never dithers an already dithered picture.
    const pixels = panel
      ? new Uint8ClampedArray(frame.buffer).slice()
      : new Uint8ClampedArray(frame.buffer)
    if (panel) {
      ditherFrame(pixels, frame.width, frame.height, panel)
    }
    context.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0)
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

  /** Let the scene render as often as it asks (true), or throttle it back
   * to one render per second (false). */
  setFastMode(enabled: boolean): void {
    this.fastMode = enabled
    this.worker?.postMessage({ type: 'setFastMode', enabled })
  }

  private assetRequest(op: string, params: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      if (!this.worker || this.destroyed) {
        reject(new Error('preview is not running'))
        return
      }
      const requestId = this.nextAssetRequestId++
      this.assetRequests.set(requestId, { resolve, reject })
      this.worker.postMessage({ type: 'assets', requestId, op, ...params }, transfer)
    })
  }

  /** Every file and folder in the browser asset folder (/srv/assets). */
  async listAssets(): Promise<PreviewAssetEntry[]> {
    const result = await this.assetRequest('list')
    if (result.info) {
      this.assetsInfo = result.info
    }
    return (result.entries ?? []) as PreviewAssetEntry[]
  }

  /** The bytes of one file in the browser asset folder. */
  async readAsset(path: string): Promise<ArrayBuffer> {
    const result = await this.assetRequest('read', { path })
    return result.data as ArrayBuffer
  }

  /** Write (create or replace) a file; missing parent folders are created. */
  async writeAsset(path: string, data: ArrayBuffer | Uint8Array | Blob): Promise<void> {
    let buffer: ArrayBuffer
    if (data instanceof Blob) {
      buffer = await data.arrayBuffer()
    } else if (data instanceof ArrayBuffer) {
      buffer = data
    } else {
      buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    }
    await this.assetRequest('write', { path, data: buffer }, [buffer])
  }

  /** Create a folder (and its parents). */
  async createAssetFolder(path: string): Promise<void> {
    await this.assetRequest('mkdir', { path })
  }

  /** Delete a file, or a folder with everything in it. */
  async deleteAsset(path: string): Promise<void> {
    await this.assetRequest('delete', { path })
  }

  /** Empty the folder and regenerate the sample images. */
  async resetAssets(): Promise<void> {
    await this.assetRequest('reset')
  }

  /** Terminate the worker; the instance cannot be reused afterwards. */
  destroy(): void {
    this.destroyed = true
    this.worker?.terminate()
    this.worker = null
    this.pendingFrame = null
    this.canvas = null
    for (const pending of this.assetRequests.values()) {
      pending.reject(new Error('preview destroyed'))
    }
    this.assetRequests.clear()
  }
}

export function createFrameOSPreview(options: FrameOSPreviewOptions): FrameOSPreview {
  return new FrameOSPreview(options)
}
