// Typed wrapper around the FrameOS preview worker (assets/preview-worker.js).
// The worker loads the emscripten-built scene runtime (frameos.js/frameos.wasm)
// and drives renders; this class owns the worker lifecycle, paints frames onto
// a canvas, and exposes events/state as callbacks.
import type { DeviceLimits } from './devices'
import { ditherFrame, panelPaletteFor, type PanelPaletteKey } from './dither'
import { attachKeyboardInput, attachPointerInput, writeHostClipboard } from './pointer'
import { PreviewCursor, type CursorSprite } from './cursor'
import { pageHasGesture, pickFiles, saveFile, type PreviewFileRequest } from './files'
import type {
  FrameOSScene,
  PreviewAssetEntry,
  PreviewAssetsInfo,
  PreviewFrame,
  PreviewRuntimeInfo,
  SceneInfo,
  AppTestReport,
} from './types'

/** What a render cost under a simulated device ceiling. */
export interface DeviceMemoryUsage {
  limitBytes: number
  usedBytes: number
  peakBytes: number
}

/** RGBA pixels of one frame, the panel's palette (placeholder entries included). */
export type BeforeDitherHook = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  palette: readonly (readonly [number, number, number])[]
) => void

/** A panel's palette as colours: grey panels spelled out as their levels. */
function panelColors(panel: NonNullable<ReturnType<typeof panelPaletteFor>>): readonly (readonly [number, number, number])[] {
  if ('grayLevels' in panel) {
    const levels: [number, number, number][] = []
    for (let i = 0; i <= panel.grayLevels; i++) {
      const value = Math.round((i * 255) / panel.grayLevels)
      levels.push([value, value, value])
    }
    return levels
  }
  return panel.colors
}

/** A preview button's payload: its label, when it has one. Listener nodes
 * filter on it (a "button" listener with label "A" only hears `{label: "A"}`). */
function buttonLabel(label: string | null): Record<string, unknown> {
  return label ? { label } : {}
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
  /** Or a scene package's bytes (a ZIP of one scene, or a template zip of
   * several: docs/scene-packages.md), loaded in place of `scenes` by a
   * bundle that reads them. */
  scenePackage?: Uint8Array
  /** Scene to select initially; defaults to the runtime's default scene. */
  sceneId?: string
  /** Public field values for that scene, set before its first render: what
   * a page keeps across a re-created preview (a resize, an edit), so the
   * first frame already shows them. `PreviewRuntimeInfo.sceneStateSeeded`
   * says whether the bundle took them; an older one renders the defaults
   * and the page sends the values with `setSceneState` instead. */
  sceneState?: Record<string, unknown>
  /** Frame name shown in logs. */
  name?: string
  /** IANA time zone for the simulated frame; defaults to the browser's. */
  timeZone?: string
  /** Frame settings (app API keys etc.); most previews run fine without. */
  settings?: Record<string, unknown>
  /** Same-origin proxy endpoint for the runtime's HTTP requests. Without it,
   * scenes fetching external data hit browser CORS limits. */
  proxyUrl?: string
  /** Send every request through `proxyUrl` without trying the browser first
   * (a self-hosted backend's proxy, which reaches what the frame reaches).
   * Otherwise the browser goes first, and an origin that fails there (CORS)
   * goes through the proxy from then on. */
  proxyFirst?: boolean
  /** The previewed frame's local network access (docs/lan-access.md):
   * `false` refuses private hosts the way that frame would, in its words.
   * Absent: nothing to copy, nothing refused. */
  lanAccess?: boolean
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
  /** The frame's render scale (frame.json `renderScale`): what JSX from a
   * .tsx app is laid out for, as a screen this many times smaller, drawn at
   * full size. 0 or omitted is automatic from the size, as on a frame. */
  renderScale?: number
  /** Show frames the way an e-ink panel would: dithered to that panel's
   * inks or greys (see ./dither). Display only — the scene renders in full
   * colour either way. Null (the default) paints the frame as rendered. */
  panelPalette?: PanelPaletteKey | null
  /** Runs on a copy of the frame's pixels right before the panel dither
   * (only when a panel palette is set): the place to do what the frame
   * itself does to a picture before dithering — fit it into the palette's
   * range, apply a colour correction. Display only, like the dither. */
  beforeDither?: BeforeDitherHook | null
  /** Run the scenes side by side, as a Pi does (docs/scene-layouts.md
   * "Windows"): a desktop layout's `app.frame.scenes` lists them, its
   * `<Scene id>` is the runtime's own instance, and a scene switched away
   * from keeps running in its window. Off (the default) previews one scene. */
  windowed?: boolean
  /** Offer the frame's own page in the scene settings (a desktop's Control
   * Panel), for a page that is a frame of its own rather than an editor's
   * preview. Its Restart and Reboot arrive as `onSceneEvent` `restart` /
   * `reboot`, a new render scale as `frameSettings` `{renderScale}`. */
  framePage?: boolean
  /** Draw the frame's own mouse cursor over the picture, as a frame with a
   * mouse draws it, with the page's cursor hidden over the canvas; off (the
   * default) shows the page's cursor in the shape the scene asks for there
   * (`cursor-*` classes, a window's resize edges). See ./cursor and
   * `setDrawnCursor`. A bundle from before (`runtimeInfo.cursor`) says
   * nothing, and the page's arrow shows. */
  drawnCursor?: boolean
  /** The FrameOS Cloud origin the Scene store scene browses and previews
   * from; defaults to https://cloud.frameos.net. The listing is fetched from
   * the worker, so another origin needs CORS or `proxyUrl`. */
  storeUrl?: string
  /** Upload and Download in the Files scene (file picker in, a download
   * out; ./files). On by default; false and the scene shows neither, as on
   * a frame. A bundle from before (`runtimeInfo.fileTransfer`) has neither. */
  fileTransfer?: boolean
  /**
   * The Files scene asked for files (Upload) or to save one (Download) when
   * the page had no gesture left to open a picker or a download with: ask
   * the person with a button of the page's own whose click calls
   * `answerFileRequest()` (and one for `cancelFileRequest()`). Called with
   * null when the request is over. Without it the page tries anyway, and a
   * picker the browser refuses stays shut.
   */
  onFileRequest?: (request: PreviewFileRequest | null) => void
  onReady?: (sceneInfo: SceneInfo, assets: PreviewAssetsInfo | null, runtime: PreviewRuntimeInfo) => void
  onFrame?: (frame: PreviewFrame) => void
  /** The mouse cursor over the picture took another shape (a CSS name):
   * for a page that mirrors the picture elsewhere and shows it there. */
  onCursor?: (shape: string) => void
  onState?: (state: Record<string, unknown>) => void
  /** The runtime changed scenes by itself (a scene switched, the scene
   * switcher, a store preview) or loaded more: what `onReady` reported, now. */
  onSceneInfo?: (sceneInfo: SceneInfo) => void
  onLog?: (message: string) => void
  onSceneEvent?: (name: string, payload: Record<string, unknown>) => void
  /** A link (`<a href>`) was tapped in a scene's UI. Defaults to opening it
   * in a new tab; a frame shows its QR code instead (docs/jsx-ui.md "Links"). */
  onOpenLink?: (url: string) => void
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

interface PendingAppTestsRequest {
  resolve: (report: AppTestReport) => void
  reject: (error: Error) => void
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
  /**
   * A render ran out of the simulated device's memory: the worker's runtime
   * was left mid-render (the longjmp out of it abandons the Nim stack), so
   * nothing more is sent to it until the preview is made again (Restart, a
   * new scene or size). Every click went on into it and came back as an
   * "event failed" error, a screenful of them per click.
   */
  private outOfMemory = false
  private assetRequests = new Map<number, PendingAssetRequest>()
  private nextAssetRequestId = 1
  private appTestsRequests = new Map<number, PendingAppTestsRequest>()
  private nextAppTestsRequestId = 1
  /** Labels of the buttons `buttonDown` pressed and `buttonUp` has not let go of. */
  private heldButtons = new Set<string>()
  /** The mouse cursor over the canvas (./cursor). */
  private cursor: PreviewCursor | null = null
  private cursorDrawn: boolean
  private cursorSprite: CursorSprite | null = null
  /** The mouse cursor's shape over the picture, as CSS names it. */
  cursorShape = 'default'
  /** What the Files scene asked of the page and the person has not answered yet. */
  fileRequest: PreviewFileRequest | null = null
  private fileRequestData: ArrayBuffer | null = null
  /** Whether `onFileRequest` was told of the request waiting. */
  private fileRequestShown = false

  /** Latest scene info from the runtime (set once `ready` fires). */
  sceneInfo: SceneInfo | null = null
  /** How the runtime's /srv/assets is backed (set once `ready` fires). */
  assetsInfo: PreviewAssetsInfo | null = null
  /** Which FrameOS version the runtime is (set once `ready` fires). */
  runtimeInfo: PreviewRuntimeInfo = {
    version: null,
    pointerEvents: false,
    inputEvents: false,
    gpioEvents: false,
    sceneStateSeeded: false,
    resize: false,
    cursor: false,
    fileTransfer: false,
  }
  /** Latest public state of the current scene. */
  state: Record<string, unknown> = {}
  /** The scene currently selected in the runtime. */
  currentSceneId: string | null = null
  /** Whether renders may run faster than once per second. */
  fastMode: boolean
  /** The panel frames are shown through, or null for the true colours. */
  panelPalette: PanelPaletteKey | null
  /** What runs on the pixels before the panel dither (see the option). */
  beforeDither: BeforeDitherHook | null

  constructor(options: FrameOSPreviewOptions) {
    this.options = options
    this.canvas = options.canvas ?? null
    this.currentSceneId = options.sceneId ?? null
    this.fastMode = Boolean(options.fastMode)
    this.panelPalette = options.panelPalette ?? null
    this.beforeDither = options.beforeDither ?? null
    this.cursorDrawn = options.drawnCursor === true
    if (this.canvas) {
      this.cursor = new PreviewCursor(this.canvas, this.cursorDrawn)
    }

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
      ...(options.scenePackage ? { scenePackage: options.scenePackage } : {}),
      settingsJson: JSON.stringify(options.settings ?? {}),
      proxyUrl: options.proxyUrl || '',
      proxyFirst: options.proxyFirst === true,
      ...(options.lanAccess === undefined ? {} : { lanAccess: options.lanAccess }),
      sceneId: options.sceneId || '',
      sceneState: options.sceneState ?? null,
      fastMode: this.fastMode,
      saveAssets: options.saveAssets === undefined ? true : options.saveAssets,
      browserAssets: options.browserAssets === undefined ? true : options.browserAssets,
      deviceLimits: options.deviceLimits ?? null,
      renderScale: options.renderScale ?? 0,
      windowed: options.windowed === true,
      framePage: options.framePage === true,
      fileTransfer: options.fileTransfer !== false,
      ...(options.storeUrl ? { storeUrl: options.storeUrl } : {}),
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
        this.runtimeInfo = {
          version: typeof msg.runtimeVersion === 'string' ? msg.runtimeVersion : null,
          pointerEvents: msg.pointerEvents === true,
          inputEvents: msg.inputEvents === true,
          gpioEvents: msg.gpioEvents === true,
          sceneStateSeeded: msg.sceneStateSeeded === true,
          resize: msg.resize === true,
          cursor: msg.cursor === true,
          fileTransfer: msg.fileTransfer === true,
        }
        this.options.onReady?.(msg.sceneInfo, this.assetsInfo, this.runtimeInfo)
        break
      case 'cursor':
        this.cursorShape = typeof msg.shape === 'string' ? msg.shape : 'default'
        this.cursorSprite = msg.sprite && typeof msg.sprite === 'object' ? (msg.sprite as CursorSprite) : null
        this.cursor?.setShape(this.cursorShape, this.cursorSprite)
        this.options.onCursor?.(this.cursorShape)
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
      case 'sceneInfo':
        if (msg.sceneInfo) {
          this.sceneInfo = msg.sceneInfo
          if (msg.sceneInfo.currentSceneId) {
            this.currentSceneId = msg.sceneInfo.currentSceneId
          }
          this.options.onSceneInfo?.(msg.sceneInfo)
        }
        break
      case 'log':
        this.options.onLog?.(String(msg.message ?? ''))
        break
      case 'openLink': {
        const url = String(msg.url ?? '')
        // The runtime opens only these (ui/layout.nim isLink); never a javascript: URL.
        if (!/^(https?:\/\/|mailto:|tel:)/i.test(url)) {
          break
        }
        if (this.options.onOpenLink) {
          this.options.onOpenLink(url)
        } else if (typeof window !== 'undefined') {
          window.open(url, '_blank', 'noopener,noreferrer')
        }
        break
      }
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
        this.outOfMemory = true
        this.options.onOutOfMemory?.({
          limitBytes: Number(msg.limitBytes ?? 0),
          usedBytes: Number(msg.usedBytes ?? 0),
          peakBytes: Number(msg.peakBytes ?? 0),
          refusedBytes: Number(msg.refusedBytes ?? 0),
        })
        break

      case 'error':
        // After running out of memory the page says so once; what the
        // abandoned runtime throws after that says nothing more.
        if (!this.outOfMemory) {
          this.options.onError?.(String(msg.message ?? 'Unknown FrameOS preview error'))
        }
        break
      case 'fastRenderRequest':
        this.options.onFastRenderRequest?.(Number(msg.intervalMs) || 0)
        break
      case 'assetsChanged':
        this.options.onAssetsChanged?.()
        break
      case 'clipboard':
        // A Copy or a Cut in the frame's UI: the computer's clipboard too.
        writeHostClipboard(String(msg.text ?? ''))
        break
      case 'fileRequest':
        this.takeFileRequest(msg)
        break
      case 'appTestsResult': {
        const pending = this.appTestsRequests.get(msg.requestId)
        if (pending) {
          this.appTestsRequests.delete(msg.requestId)
          if (msg.ok) {
            pending.resolve(msg.report as AppTestReport)
          } else {
            pending.reject(new Error(String(msg.error ?? 'could not run the app tests')))
          }
        }
        break
      }
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
    if (canvas !== this.canvas) {
      this.cursor?.detach()
      this.cursor = canvas ? new PreviewCursor(canvas, this.cursorDrawn) : null
      this.cursor?.setShape(this.cursorShape, this.cursorSprite)
    }
    this.canvas = canvas
    this.paint()
  }

  /** Draw the frame's own mouse cursor over the picture (the page's hidden
   * over the canvas), or show the page's in the scene's shape: the
   * `drawnCursor` option, switched. */
  setDrawnCursor(drawn: boolean): void {
    this.cursorDrawn = drawn
    this.cursor?.setDrawn(drawn)
  }

  /** Show frames through a panel's palette (or null for true colour), and
   * repaint the frame already on screen — no re-render needed, the picture
   * is the same one. */
  setPanelPalette(palette: PanelPaletteKey | null): void {
    this.panelPalette = palette
    this.paint()
  }

  /** Replace the pre-dither hook and repaint the kept frame through it. */
  setBeforeDither(hook: BeforeDitherHook | null): void {
    this.beforeDither = hook
    this.paint()
  }

  private paint(): void {
    const canvas = this.canvas
    const frame = this.pendingFrame
    if (!canvas || !frame || !frame.buffer.byteLength) {
      return
    }
    // The frame's cursor is never in a frame: put away, then drawn again
    // over the new one (./cursor).
    this.cursor?.away()
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
    const pixels = panel ? new Uint8ClampedArray(frame.buffer).slice() : new Uint8ClampedArray(frame.buffer)
    if (panel) {
      if (this.beforeDither) {
        this.beforeDither(pixels, frame.width, frame.height, panelColors(panel))
      }
      ditherFrame(pixels, frame.width, frame.height, panel)
    }
    context.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0)
    this.cursor?.back()
  }

  /** A message the worker answers by calling into the runtime. */
  private toRuntime(msg: Record<string, unknown>, transfer: Transferable[] = []): void {
    if (!this.outOfMemory) {
      this.worker?.postMessage(msg, transfer)
    }
  }

  /** The worker's `fileRequest`: answered now while the page still has the
   * tap's gesture, else asked of the person (`onFileRequest`). A new one
   * replaces one still waiting, as it does in the runtime. */
  private takeFileRequest(msg: Record<string, any>): void {
    const op = msg.op === 'upload' || msg.op === 'download' ? msg.op : null
    const id = Number(msg.id) || 0
    if (!op || !id) {
      return
    }
    this.fileRequest = { id, op, name: String(msg.name ?? '') }
    this.fileRequestData = op === 'download' && msg.data instanceof ArrayBuffer ? msg.data : null
    if (pageHasGesture() || !this.options.onFileRequest) {
      this.answerFileRequest()
    } else {
      this.fileRequestShown = true
      this.options.onFileRequest(this.fileRequest)
    }
  }

  private endFileRequest(): void {
    this.fileRequest = null
    this.fileRequestData = null
    if (this.fileRequestShown) {
      this.fileRequestShown = false
      this.options.onFileRequest?.(null)
    }
  }

  /**
   * Do what the Files scene asked (`fileRequest`): open the file picker and
   * put the files picked into the folder it showed, or save the file to the
   * computer. Call it from a click (a gesture): a picker opened from
   * anywhere else stays shut. Nothing without a request waiting.
   */
  answerFileRequest(): void {
    const request = this.fileRequest
    if (!request) {
      return
    }
    const data = this.fileRequestData
    this.endFileRequest()
    if (request.op === 'download') {
      try {
        saveFile(request.name, data ?? new ArrayBuffer(0))
        this.toRuntime({ type: 'fileTransferDone', id: request.id, ok: true })
      } catch {
        this.toRuntime({ type: 'fileTransferDone', id: request.id, ok: false, error: 'failed' })
      }
      return
    }
    void pickFiles().then((files) => {
      if (this.destroyed) {
        return
      }
      if (!files || files.length === 0) {
        this.toRuntime({ type: 'fileTransferDone', id: request.id, ok: false, error: 'cancelled' })
        return
      }
      this.toRuntime(
        { type: 'fileUpload', id: request.id, files },
        files.map((file) => file.data)
      )
    })
  }

  /** Give up what the Files scene asked: the scene says nothing was moved. */
  cancelFileRequest(): void {
    const request = this.fileRequest
    if (!request) {
      return
    }
    this.endFileRequest()
    this.toRuntime({ type: 'fileTransferDone', id: request.id, ok: false, error: 'cancelled' })
  }

  /** Force a render now. */
  render(): void {
    this.toRuntime({ type: 'render' })
  }

  /** Dispatch a scene event (a custom event node's keyword, "button", ...). */
  sendEvent(name: string, payload: Record<string, unknown> = {}): void {
    this.toRuntime({ type: 'event', name, payload })
  }

  /**
   * A button held like a frame's key: call `buttonDown` when the pointer (or
   * the keyboard) presses it and `buttonUp` when it lets go, and the scene
   * gets the `gpio` edges as they happen, `down` and `up` (level 0 is down:
   * the line is pulled up). The runtime adds the role and the `up`'s
   * `durationMs`, and makes the `button` `press`, `doublePress` or
   * `longPress` the edges add up to. A preview button has no pin; the label
   * tells keys apart. A bundle from before `gpio` (`runtimeInfo.gpioEvents`)
   * gets one `button` for the whole press, on the release.
   */
  buttonDown(label: string | null): void {
    const key = label ?? ''
    if (this.heldButtons.has(key)) {
      return
    }
    this.heldButtons.add(key)
    if (this.runtimeInfo.gpioEvents) {
      this.sendEvent('gpio', { ...buttonLabel(label), level: 0, action: 'down' })
    }
  }

  /** The release of a key `buttonDown` pressed; nothing for one it did not. */
  buttonUp(label: string | null): void {
    if (!this.heldButtons.delete(label ?? '')) {
      return
    }
    const payload = buttonLabel(label)
    if (this.runtimeInfo.gpioEvents) {
      this.sendEvent('gpio', { ...payload, level: 1, action: 'up' })
    } else {
      this.sendEvent('button', payload)
    }
  }

  /**
   * Pass the pointer and the wheel over `canvas` on to the scene as
   * `pointerMove` / `pointerDown` / `pointerUp` / `pointerCancel` / `wheel`,
   * the events a frame's mouse or touchscreen sends (see ./pointer; a bundle
   * from before input v2 gets `mouseMove` / `mouseDown` / `mouseUp`). Any
   * canvas showing the frame will do — the one frames are painted onto, or a
   * mirror of it. Nothing is forwarded to a runtime bundle that predates
   * pointer input (`runtimeInfo.pointerEvents`). Returns the detach function;
   * `destroy()` does not need it called first.
   */
  attachPointerInput(canvas: HTMLCanvasElement): () => void {
    return attachPointerInput(canvas, (name, payload) => this.sendEvent(name, payload), {
      enabled: () => !this.destroyed && this.runtimeInfo.pointerEvents,
      inputV2: () => this.runtimeInfo.inputEvents,
    })
  }

  /**
   * Pass the keyboard, while `canvas` has the focus, on to the scene as
   * `keyDown` / `keyUp` / `textInput` (see ./pointer). Give the canvas a
   * `tabIndex`; a press on it focuses it. Nothing is forwarded to a bundle
   * from before input v2 (`runtimeInfo.inputEvents`).
   */
  attachKeyboardInput(canvas: HTMLCanvasElement): () => void {
    return attachKeyboardInput(canvas, (name, payload) => this.sendEvent(name, payload), {
      enabled: () => !this.destroyed && this.runtimeInfo.inputEvents,
      onPaste: (text) => this.setClipboard(text),
    })
  }

  /**
   * The frame's clipboard (docs/jsx-ui.md "Selecting, copying and pasting"):
   * what its next Paste types. The keyboard sets it from the computer's
   * before a Ctrl/Cmd+V; the frame's own Copy and Cut go the other way, onto
   * the computer's clipboard, by themselves.
   */
  setClipboard(text: string): void {
    this.toRuntime({ type: 'clipboard', text })
  }

  /** Update the current scene's state fields; renders by default. */
  setSceneState(state: Record<string, unknown>, render = true): void {
    this.sendEvent('setSceneState', { state, render })
  }

  /** Switch the runtime to another loaded scene. */
  selectScene(sceneId: string): void {
    this.currentSceneId = sceneId
    this.toRuntime({ type: 'selectScene', sceneId })
  }

  /**
   * A new size for the frame, everything kept running (a desktop's windows,
   * a form's edits) and drawn again at it. Only a bundle that says so
   * (`runtimeInfo.resize`) can; for another, create the preview again.
   */
  resize(width: number, height: number): void {
    this.toRuntime({ type: 'resize', width, height })
  }

  /**
   * The layout every scene wears, as the frame's own settings page chooses
   * it: a layout scene's id, `"none"` for none, `""` for each scene's own.
   * On a desktop the one chosen opens what the one before had open.
   */
  chooseLayout(layoutId: string): void {
    this.toRuntime({ type: 'chooseLayout', layoutId })
  }

  /** The frame's render scale (0 = automatic), drawn again at once. */
  setRenderScale(scale: number): void {
    this.toRuntime({ type: 'setRenderScale', scale })
  }

  /** Let the scene render as often as it asks (true), or throttle it back
   * to one render per second (false). */
  setFastMode(enabled: boolean): void {
    this.fastMode = enabled
    this.worker?.postMessage({ type: 'setFastMode', enabled })
  }

  /**
   * Run one test file of a JavaScript app (`<name>.test.ts` among its
   * sources) in this runtime's interpreter, with the frame this preview was
   * given, and resolve with the harness's report. Rejects when the file does
   * not load or the bundle predates app tests (FrameOS 2026.10.16).
   */
  runAppTests(app: { sources: Record<string, string> }, testFile: string): Promise<AppTestReport> {
    return new Promise((resolve, reject) => {
      if (!this.worker || this.destroyed) {
        reject(new Error('preview is not running'))
        return
      }
      const requestId = this.nextAppTestsRequestId++
      this.appTestsRequests.set(requestId, { resolve, reject })
      this.worker.postMessage({
        type: 'runAppTests',
        requestId,
        appJson: JSON.stringify({ sources: app.sources }),
        testFile,
      })
    })
  }

  private assetRequest(
    op: string,
    params: Record<string, unknown> = {},
    transfer: Transferable[] = []
  ): Promise<Record<string, any>> {
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
    this.cursor?.detach()
    this.cursor = null
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
