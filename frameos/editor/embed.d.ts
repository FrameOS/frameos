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
