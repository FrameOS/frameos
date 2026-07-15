import ReactDOM from 'react-dom/client'
import '../utils/configureMonaco'
import '../index.css'
import { initKea } from '../initKea'
import { EmbeddedEditor } from './EmbeddedEditor'

// Standalone embedded scene editor (AGPL, like all of FrameOS). Built as its
// own bundle with frameLogic/logsLogic swapped for in-memory shims — no
// backend, no websocket; scenes arrive and leave over postMessage. See
// EmbeddedEditor.tsx for the protocol and build.mjs for the alias setup.

initKea()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<EmbeddedEditor />)
