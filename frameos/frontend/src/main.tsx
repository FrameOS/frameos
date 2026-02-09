import { createRoot } from 'react-dom/client'
import { resetContext } from 'kea'
import { routerPlugin } from 'kea-router'
import { App } from './scenes/App'
import './index.css'

if (typeof window !== 'undefined') {
  ;(window as any).FRAMEOS_APP_CONFIG = {
    ...(window as any).FRAMEOS_APP_CONFIG,
    frameMode: 'frame',
    frameId: 1,
  }
}

resetContext({
  plugins: [routerPlugin()],
})

const rootElement = document.getElementById('root')

if (rootElement) {
  const root = createRoot(rootElement)
  root.render(<App />)
}
