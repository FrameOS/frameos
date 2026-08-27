import '../utils/configureMonaco'
import '../index.css'
import { initKea } from '../initKea'

// The scene editor as an importable React library (`frameos-editor/react`):
// esbuild bundles kea, reactflow, Monaco and the rest, but externalizes
// react/react-dom, so EmbeddedSceneEditor renders in the host app's React
// tree as a plain component. The stylesheet is emitted next to this bundle
// as lib.css; Monaco workers load from ./monaco/ relative to wherever the
// dist is served (FRAMEOS_APP_CONFIG.ingress_path).

if (typeof window !== 'undefined') {
  const anyWindow = window as any
  anyWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true
  anyWindow.ESBUILD_LOAD_CHUNKS = anyWindow.ESBUILD_LOAD_CHUNKS || function () {}
  initKea({ memoryRouter: true })
}

export { EmbeddedSceneEditor } from './EmbeddedEditor'
export type { EmbeddedSceneEditorProps, EmbeddedSceneEditorScreenshotResult } from './EmbeddedEditor'
