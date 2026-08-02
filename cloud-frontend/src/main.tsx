import { createRoot } from 'react-dom/client'
import { App } from './scenes/App'
import './index.css'
import { initKea } from '../../frontend/src/initKea'
import { registerAddFramePanel } from '../../frontend/src/scenes/workspace/addFramePanelRegistry'
import { CloudAddFrameDrawer } from './components/CloudAddFrameDrawer'
import { cloudAssetsBasePath, cloudRouteBasePath } from './routes'

if (typeof window !== 'undefined') {
  // Cloud mode is NOT frameMode: the fleet has many frames, and project
  // scoping is skipped via the apiFetch cloud branch instead. The same
  // values live in src/index.html so they apply before the bundle loads;
  // this merge keeps them authoritative even if the shell drifts.
  ;(window as any).FRAMEOS_APP_CONFIG = {
    ...(window as any).FRAMEOS_APP_CONFIG,
    cloudMode: true,
    frameMode: undefined,
    ingress_path: '',
    route_base_path: cloudRouteBasePath,
    assets_base_path: cloudAssetsBasePath,
  }
}

// "Add frame" in the shared workspace means something different on every
// control plane, and only this bundle knows the cloud's answer: claim codes,
// SD images and ESP32 flashing. frontend/ must never import cloud-frontend/
// (the same sources build the self-hosted and on-device bundles), so the panel
// is handed down instead — registered before the first render, so FramesHome
// sees it the moment it mounts.
registerAddFramePanel(CloudAddFrameDrawer)

initKea()

const rootElement = document.getElementById('root')

if (rootElement) {
  const root = createRoot(rootElement)
  root.render(<App />)
}
