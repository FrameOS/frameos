import ReactDOM from 'react-dom/client'
import { App } from './scenes/App'
import './index.css'
import { resetContext } from 'kea'
import { subscriptionsPlugin } from 'kea-subscriptions'

resetContext({
  plugins: [subscriptionsPlugin],
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
