import { LazyExoticComponent, Suspense } from 'react'
import { useValues } from 'kea'

import { sceneLogic } from './sceneLogic'
import { scenes } from './scenes'

export function App() {
  const { scene, params } = useValues(sceneLogic)
  const SceneComponent: (() => JSX.Element) | LazyExoticComponent<any> =
    scenes[scene as keyof typeof scenes] || scenes.error404

  return (
    <Suspense fallback={<div />}>
      <SceneComponent {...params} />
    </Suspense>
  )
}
