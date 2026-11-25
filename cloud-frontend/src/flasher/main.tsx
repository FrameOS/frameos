import { createRoot } from 'react-dom/client'

import { initKea } from '../../../frontend/src/initKea'
import { embeddedUsbLogsModel } from '../../../frontend/src/models/embeddedUsbLogsModel'
import { FlasherApp } from './FlasherApp'
import './flasher.css'

// flash.frameos.net (cloud/docs/flasher.md): its own entry in this package's
// build (build.mjs), served by auth-web at /flash and at the flasher host's
// root. No workspace, no account: the shared flashing engine, a board, and
// whatever handed it a job.
if (typeof window !== 'undefined') {
  ;(window as any).FRAMEOS_APP_CONFIG = {
    ...(window as any).FRAMEOS_APP_CONFIG,
    cloudMode: true,
    ingress_path: '',
  }
}

// A memory router: the page has one address, and must leave it alone.
initKea({ memoryRouter: true })
embeddedUsbLogsModel.mount()

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<FlasherApp />)
}
