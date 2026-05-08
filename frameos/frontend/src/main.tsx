import { createRoot } from 'react-dom/client'
import { App } from './scenes/App'
import './index.css'
import { initKea } from '../../../frontend/src/initKea'

if (typeof window !== 'undefined') {
  ;(window as any).FRAMEOS_APP_CONFIG = {
    ...(window as any).FRAMEOS_APP_CONFIG,
    frameMode: 'frame',
    frameId: 1,
  }
}

initKea()

const rootElement = document.getElementById('root')

if (rootElement) {
  const root = createRoot(rootElement)
  root.render(<App />)
}
