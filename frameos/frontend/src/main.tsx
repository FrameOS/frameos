import { createRoot } from 'react-dom/client'
import { resetContext } from 'kea'
import { routerPlugin } from 'kea-router'
import { App } from './scenes/App'
import './index.css'

resetContext({
  plugins: [routerPlugin()],
})

const rootElement = document.getElementById('root')

if (rootElement) {
  const root = createRoot(rootElement)
  root.render(<App />)
}
