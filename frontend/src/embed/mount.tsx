import ReactDOM from 'react-dom/client'
import '../utils/configureMonaco'
import '../index.css'
import { initKea } from '../initKea'
import { EmbeddedEditor } from './EmbeddedEditor'
import type { FrameScene } from '../types'

// Direct, iframe-free mount of the embedded scene editor: render the editor
// into a host-page element. EmbeddedEditor's postMessage bus works unchanged
// because window.parent === window when not framed — this wrapper is the
// "parent" side of the same documented protocol, in the same window.
//
// The host page provides a sized container (the editor fills it, h-full);
// this module owns everything else: the stylesheet (injected while mounted,
// removed on destroy — the editor CSS is global, so hosts should only mount
// full-viewport overlays), the #modal/#popper portal roots, the theme
// attribute on <html>, and the Monaco/chunk asset base derived from this
// module's own URL.

export interface FrameOSEditorScreenshotResult {
  ok: boolean
  error?: string
  /** When false, a failed save does not fall back to a local PNG download. */
  fallbackDownload?: boolean
}

export interface FrameOSEditorMountOptions {
  scenes: FrameScene[]
  sceneId?: string
  mode?: string
  width?: number
  height?: number
  interval?: number
  theme?: 'light' | 'dark'
  /** Same-origin endpoint the wasm preview routes CORS-blocked fetches through. */
  previewProxyUrl?: string
  /** Host-page description of the scene, shown in Scene settings. */
  description?: string
  onReady?: () => void
  onScenesChanged?: (scenes: FrameScene[]) => void
  /**
   * Preview-panel screenshot handler. Return {ok: true} once stored; omit the
   * handler (or return {ok: false, fallbackDownload: true}) to let the editor
   * download the PNG locally instead.
   */
  onSaveScreenshot?: (dataUrl: string, sceneId: string | null) => Promise<FrameOSEditorScreenshotResult>
}

export interface FrameOSEditorHandle {
  /** Latest scenes as reported by the editor (kept current on every edit). */
  getScenesSync: () => FrameScene[]
  /** Ask the editor for its current scenes. */
  getScenes: () => Promise<FrameScene[]>
  /** Replace the loaded scenes (re-initializes the editor). */
  setScenes: (scenes: FrameScene[], sceneId?: string) => void
  selectScene: (sceneId: string) => void
  destroy: () => void
}

let keaInitialized = false
let active = false

function ensurePortalRoot(id: string, zIndex: string): HTMLElement {
  let element = document.getElementById(id)
  if (!element) {
    element = document.createElement('div')
    element.id = id
    element.style.position = 'absolute'
    element.style.zIndex = zIndex
    element.dataset.frameosEditorOwned = 'true'
    document.body.appendChild(element)
  }
  return element
}

export function mountFrameOSEditor(container: HTMLElement, options: FrameOSEditorMountOptions): FrameOSEditorHandle {
  if (active) {
    throw new Error('mountFrameOSEditor: an editor is already mounted (the message bus is window-wide)')
  }
  active = true

  // Assets (chunks, Monaco workers, the stylesheet) live next to this module:
  // <dist>/static/mount.js → asset base <dist>.
  const assetBase = new URL('..', import.meta.url)
  const anyWindow = window as any
  anyWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true
  anyWindow.ESBUILD_LOAD_CHUNKS = anyWindow.ESBUILD_LOAD_CHUNKS || function () {}
  const config = (anyWindow.FRAMEOS_APP_CONFIG = anyWindow.FRAMEOS_APP_CONFIG || {})
  config.ingress_path = assetBase.pathname.replace(/\/$/, '')

  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'
  stylesheet.href = new URL('./static/mount.css', assetBase).href
  document.head.appendChild(stylesheet)

  const modalRoot = ensurePortalRoot('modal', '60')
  const popperRoot = ensurePortalRoot('popper', '90')

  const html = document.documentElement
  const previousTheme = html.dataset.frameosTheme
  const previousColorScheme = html.style.colorScheme
  const theme = options.theme ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  html.dataset.frameosTheme = theme
  html.style.colorScheme = theme

  if (!keaInitialized) {
    initKea({ memoryRouter: true })
    keaInitialized = true
  }

  let latestScenes = options.scenes
  let ready = false
  const sceneWaiters: ((scenes: FrameScene[]) => void)[] = []

  const initMessage = (scenes: FrameScene[], sceneId?: string) => ({
    type: 'frameos-editor:init',
    scenes,
    sceneId,
    mode: options.mode ?? 'rpios',
    width: options.width ?? 800,
    height: options.height ?? 480,
    interval: options.interval ?? 300,
    theme,
    previewProxyUrl: options.previewProxyUrl,
    description: options.description,
  })

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== window) {
      return
    }
    const message = event.data
    if (!message || typeof message !== 'object') {
      return
    }
    if (message.type === 'frameos-editor:ready') {
      ready = true
      window.postMessage(initMessage(latestScenes, options.sceneId), window.location.origin)
      options.onReady?.()
    } else if (message.type === 'frameos-editor:scenes' && Array.isArray(message.scenes)) {
      latestScenes = message.scenes
      while (sceneWaiters.length > 0) {
        sceneWaiters.shift()?.(message.scenes)
      }
      options.onScenesChanged?.(message.scenes)
    } else if (message.type === 'frameos-editor:save-screenshot' && typeof message.dataUrl === 'string') {
      if (!options.onSaveScreenshot) {
        return // no ack → the editor falls back to a local download
      }
      void options.onSaveScreenshot(message.dataUrl, typeof message.sceneId === 'string' ? message.sceneId : null)
        .catch((error): FrameOSEditorScreenshotResult => ({ ok: false, error: String(error) }))
        .then((result) => {
          window.postMessage({ type: 'frameos-editor:screenshot-saved', ...result }, window.location.origin)
        })
    }
  }
  window.addEventListener('message', onMessage)

  const rootElement = document.createElement('div')
  rootElement.style.height = '100%'
  container.appendChild(rootElement)
  const root = ReactDOM.createRoot(rootElement)
  root.render(<EmbeddedEditor />)

  return {
    getScenesSync: () => latestScenes,
    getScenes: () =>
      new Promise((resolve) => {
        if (!ready) {
          resolve(latestScenes)
          return
        }
        sceneWaiters.push(resolve)
        window.postMessage({ type: 'frameos-editor:get-scenes' }, window.location.origin)
      }),
    setScenes: (scenes, sceneId) => {
      latestScenes = scenes
      window.postMessage(initMessage(scenes, sceneId), window.location.origin)
    },
    selectScene: (sceneId) => {
      window.postMessage({ type: 'frameos-editor:select-scene', sceneId }, window.location.origin)
    },
    destroy: () => {
      window.removeEventListener('message', onMessage)
      root.unmount()
      rootElement.remove()
      stylesheet.remove()
      if (modalRoot.dataset.frameosEditorOwned) {
        modalRoot.remove()
      }
      if (popperRoot.dataset.frameosEditorOwned) {
        popperRoot.remove()
      }
      if (previousTheme === undefined) {
        delete html.dataset.frameosTheme
      } else {
        html.dataset.frameosTheme = previousTheme
      }
      html.style.colorScheme = previousColorScheme
      active = false
    },
  }
}
