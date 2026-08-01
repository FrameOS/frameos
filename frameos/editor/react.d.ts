// Types for `frameos-editor/react` (dist/static/lib.js): the scene editor as
// a plain React component. The bundle carries kea, reactflow and Monaco but
// externalizes react/react-dom — it renders in the host app's React tree
// (React 19+). Browser-only: render it client-side.
//
// Serve the package's dist/ from the host origin; Monaco workers load from
// `${FRAMEOS_APP_CONFIG.ingress_path}/static/monaco/` (set ingress_path to
// the served dist path, e.g. "/frameos-editor", before first render) and the
// stylesheet is emitted as dist/static/lib.css — load it while the editor is
// shown (it is a global stylesheet: tailwind preflight included, so scope its
// lifetime to full-viewport editor views).

import type { JSX } from 'react'

export interface EmbeddedSceneEditorScreenshotResult {
  ok: boolean
  error?: string | undefined
  /** When false, a failed save does not fall back to a local PNG download. */
  fallbackDownload?: boolean | undefined
}

export interface EmbeddedSceneEditorProps {
  scenes: unknown[]
  sceneId?: string | undefined
  mode?: string | undefined
  width?: number | undefined
  height?: number | undefined
  interval?: number | undefined
  theme?: 'light' | 'dark' | undefined
  /** Same-origin endpoint the wasm preview routes CORS-blocked fetches through. */
  previewProxyUrl?: string | undefined
  /** Host-page description of the scene, shown in the Scene settings panel. */
  description?: string | undefined
  /** Fires (debounced) after every edit with the full scenes JSON. */
  onScenesChanged?: ((scenes: unknown[]) => void) | undefined
  /** Preview-panel screenshot handler; omit to let the editor download the PNG locally. */
  onSaveScreenshot?: ((dataUrl: string, sceneId: string | null) => Promise<EmbeddedSceneEditorScreenshotResult>) | undefined
}

export function EmbeddedSceneEditor(props: EmbeddedSceneEditorProps): JSX.Element
