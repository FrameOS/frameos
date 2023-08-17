import { LazyExoticComponent, Suspense } from 'react'
import { useMountedLogic, useValues } from 'kea'
import { sceneLogic } from './sceneLogic'
import { scenes } from './scenes'
import { socketLogic } from './socketLogic'
import { framesModel } from '../models/framesModel'
import { appsModel } from '../models/appsModel'

export function App() {
  useMountedLogic(socketLogic)
  useMountedLogic(appsModel)
  useMountedLogic(framesModel)
  const { scene, params } = useValues(sceneLogic)

  const SceneComponent: (() => JSX.Element) | LazyExoticComponent<any> =
    scenes[scene as keyof typeof scenes] || scenes.error404

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SceneComponent {...params} />
    </Suspense>
  )
}
