// Types for the direct (iframe-free) mount entry, `frameos-editor/mount`
// (dist/static/mount.js — an ESM module that bundles its own React and must
// be served, with the rest of dist/, from the host origin; chunk, worker,
// and stylesheet URLs resolve relative to the module itself).
//
// The editor's stylesheet is global while mounted (removed on destroy), so
// hosts should mount full-viewport overlays rather than inline widgets.

export interface FrameOSEditorScreenshotResult {
  ok: boolean
  error?: string
  /** When false, a failed save does not fall back to a local PNG download. */
  fallbackDownload?: boolean
}

export interface FrameOSEditorMountOptions {
  scenes: unknown[]
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
  onScenesChanged?: (scenes: unknown[]) => void
  /**
   * Preview-panel screenshot handler. Return {ok: true} once stored; omit the
   * handler to let the editor download the PNG locally instead.
   */
  onSaveScreenshot?: (dataUrl: string, sceneId: string | null) => Promise<FrameOSEditorScreenshotResult>
}

export interface FrameOSEditorHandle {
  /** Latest scenes as reported by the editor (kept current on every edit). */
  getScenesSync: () => unknown[]
  /** Ask the editor for its current scenes. */
  getScenes: () => Promise<unknown[]>
  /** Replace the loaded scenes (re-initializes the editor). */
  setScenes: (scenes: unknown[], sceneId?: string) => void
  selectScene: (sceneId: string) => void
  destroy: () => void
}

export function mountFrameOSEditor(container: HTMLElement, options: FrameOSEditorMountOptions): FrameOSEditorHandle
