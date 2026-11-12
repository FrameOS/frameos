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
  /**
   * The template's listing, the file tree's template.json. With one the
   * editor opens on template.json and edits it; without, it is read only.
   */
  template?: FrameOSEditorTemplate
  /** The template.json fields the host keeps; the form edits those alone
   * (default: all but `name`). */
  templateFields?: ('name' | 'description' | 'category' | 'frameosVersion' | 'tags')[]
  /** Fires (debounced) after every edit with the full scenes array. */
  onScenesChanged?: (scenes: Record<string, unknown>[]) => void
  /** Fires after every edit to template.json, with the whole template. */
  onTemplateChanged?: (template: FrameOSEditorTemplate) => void
  onReady?: () => void
}

export interface FrameOSEditorTemplate {
  name: string
  description: string | null
  category: string | null
  tags: string[]
  /** The oldest FrameOS that runs the template's scenes (e.g. "2026.11.3"). */
  frameosVersion: string | null
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
