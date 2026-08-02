import { LazyExoticComponent, Suspense } from 'react'
import { useValues } from 'kea'

import { AccountHeader } from '../components/AccountHeader'
import { sceneLogic } from './sceneLogic'
import { scenes } from './scenes'

// Layout contract (see .frameos-cloud-app in src/index.css): the account
// header is persistent chrome that never scrolls away and never re-mounts per
// scene, and the workspace shell below it owns everything that is left of the
// viewport. The shell brings its own scrolling (a fixed rail, fixed drawers,
// a scrolling <main>), so this wrapper must not add a second, page-level
// scrollbar — that is what would break the drawers' sizing.
export function App(): JSX.Element {
  const { scene, params } = useValues(sceneLogic)
  const SceneComponent: (() => JSX.Element) | LazyExoticComponent<any> =
    scenes[scene as keyof typeof scenes] || scenes.error404

  return (
    <div className="frameos-cloud-app">
      <AccountHeader />
      <div className="frameos-cloud-app__shell">
        <Suspense fallback={<div />}>
          <SceneComponent {...params} />
        </Suspense>
      </div>
    </div>
  )
}
