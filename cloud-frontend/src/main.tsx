import { createRoot } from 'react-dom/client'
import { App } from './scenes/App'
import './index.css'
import { initKea } from '../../frontend/src/initKea'
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

initKea()

const rootElement = document.getElementById('root')

if (rootElement) {
  const root = createRoot(rootElement)
  root.render(<App />)
}
