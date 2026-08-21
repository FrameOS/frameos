import { createRoot } from 'react-dom/client'
// Point @monaco-editor/react at the bundled monaco BEFORE anything renders an
// editor: without this it lazy-loads monaco from a CDN, which the cloud's CSP
// blocks — every Monaco surface (app sources, scene JSON, code nodes) then
// fails with a bare script error. The workers it spawns are bundled by
// build.mjs into static/monaco/ (same contract as the other bundles).
import '../../frontend/src/utils/configureMonaco'
import { App } from './scenes/App'
import './index.css'
import { initKea } from '../../frontend/src/initKea'
import { registerAddFramePanel, registerFramePanel } from '../../frontend/src/scenes/workspace/addFramePanelRegistry'
import { CloudAddFrameDrawer } from './components/CloudAddFrameDrawer'
import { CloudFrameSdImageCard } from './components/CloudFrameSdImageCard'
import { CloudFrameUsbRelink } from './components/CloudFrameUsbRelink'
import { cloudAssetsBasePath, cloudRouteBasePath, legacyCloudPathRedirect } from './routes'
import { seedThemeFromSharedCookie, syncThemeToSharedCookie } from './cloudThemeSync'

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

  // Pre-2026.8 workspace URLs, rewritten before the router reads the
  // location so they never reach the 404 scene.
  const redirect = legacyCloudPathRedirect(window.location.pathname)
  if (redirect) {
    window.history.replaceState(window.history.state, '', redirect + window.location.search + window.location.hash)
  }
}

// "Add frame" in the shared workspace means something different on every
// control plane, and only this bundle knows the cloud's answer: claim codes,
// SD images and ESP32 flashing. frontend/ must never import cloud-frontend/
// (the same sources build the self-hosted and on-device bundles), so the panel
// is handed down instead — registered before the first render, so FramesHome
// sees it the moment it mounts.
registerAddFramePanel(CloudAddFrameDrawer)

// Same handoff for the two per-frame enrollment operations the deploy drawer
// offers — re-linking a wiped ESP32, and writing another SD card for a Pi.
// Both mint a claim token bound to an existing frame, which only this bundle
// can do.
registerFramePanel('usbRelink', CloudFrameUsbRelink)
registerFramePanel('sdImage', CloudFrameSdImageCard)

// The account pages and this workspace share one theme preference. Seeding
// must happen before initKea — authThemeLogic reads its stored value once,
// when the reducer default is evaluated.
seedThemeFromSharedCookie()

initKea()

syncThemeToSharedCookie()

const rootElement = document.getElementById('root')

if (rootElement) {
  const root = createRoot(rootElement)
  root.render(<App />)
}
