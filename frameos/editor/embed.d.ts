export interface FrameOSEditorOptions {
  /** Element the editor iframe is appended to. */
  container: HTMLElement
  /** URL of the editor bundle's index.html (serve this package's dist/). */
  url: string
  /** The scenes to edit — the parsed contents of a scenes.json. */
  scenes: Record<string, unknown>[]
  /** Scene to open initially; defaults to the default scene. */
  sceneId?: string
  /** Frame mode; decides code-node language (default 'rpios'). */
  mode?: string
  width?: number
  height?: number
  interval?: number
  /** Editor color theme; defaults to the browser's preferred color scheme. */
  theme?: 'light' | 'dark'
  /**
   * Same-origin endpoint the in-editor wasm live preview routes CORS-blocked
   * HTTP requests through (appended as `?url=`-style proxy by the runtime).
   * Without it the preview still runs, but scenes fetching external data may
   * render incompletely.
   */
  previewProxyUrl?: string
  /**
   * The embedding page's description of the scene (scenes.json doesn't carry
   * one); shown in the editor's Scene settings panel.
   */
  description?: string
  /** Fires (debounced) after every edit with the full scenes array. */
  onScenesChanged?: (scenes: Record<string, unknown>[]) => void
  onReady?: () => void
}

export interface FrameOSEditorHandle {
  iframe: HTMLIFrameElement
  getScenesSync: () => Record<string, unknown>[]
  getScenes: () => Promise<Record<string, unknown>[]>
  setScenes: (scenes: Record<string, unknown>[], sceneId?: string) => void
  selectScene: (sceneId: string) => void
  destroy: () => void
}

export function createFrameOSEditor(options: FrameOSEditorOptions): FrameOSEditorHandle
