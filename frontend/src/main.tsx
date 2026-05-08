import ReactDOM from 'react-dom/client'
import { App } from './scenes/App'
import './index.css'
import { initKea } from './initKea'

initKea()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
