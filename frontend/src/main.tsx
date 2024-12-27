import ReactDOM from 'react-dom/client'
import { App } from './scenes/App'
import './index.css'
import { resetContext } from 'kea'
import { subscriptionsPlugin } from 'kea-subscriptions'
import { routerPlugin } from 'kea-router'
import { getBasePath } from './utils/getBasePath'

function addIngressPathIfMissing(path: string): string {
  const ingressPath = getBasePath()
  if (ingressPath && path.startsWith(ingressPath)) {
    return path
  }
  return `${ingressPath}${path}`
}

function removeIngressPathIfPressent(path: string): string {
  const ingressPath = getBasePath()
  if (ingressPath && path.startsWith(ingressPath)) {
    return path.slice(ingressPath.length)
  }
  return path
}

resetContext({
  plugins: [
    subscriptionsPlugin,
    routerPlugin({
      // pathFromRoutesToWindow: (path) => {
      //   return addIngressPathIfMissing(path)
      // },
      // transformPathInActions: (path) => {
      //   return addIngressPathIfMissing(path)
      // },
      // pathFromWindowToRoutes: (path) => {
      //   return removeIngressPathIfPressent(path)
      // },
    }),
  ],
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
