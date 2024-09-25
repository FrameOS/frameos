import { LazyExoticComponent, Suspense, useEffect, useState } from 'react'
import { useMountedLogic, useValues } from 'kea'
import { sceneLogic } from './sceneLogic'
import { scenes } from './scenes'
import { socketLogic } from './socketLogic'
import { framesModel } from '../models/framesModel'
import { appsModel } from '../models/appsModel'
import { templatesModel } from '../models/templatesModel'

export function DelayedLoading() {
  const [delayed, setDelayed] = useState(false)
  useEffect(() => {
    const timeout = setTimeout(() => setDelayed(true), 1000)
    return () => clearTimeout(timeout)
  }, [])
  if (!delayed) {
    return <div />
  }
  return <div className="w-full h-screen flex items-center justify-center">Loading...</div>
}

export function LoggedInApp() {
  useMountedLogic(socketLogic)
  useMountedLogic(appsModel)
  useMountedLogic(framesModel)
  useMountedLogic(templatesModel)
  const { scene, params } = useValues(sceneLogic)

  const SceneComponent: (() => JSX.Element) | LazyExoticComponent<any> =
    scenes[scene as keyof typeof scenes] || scenes.error404

  return (
    <Suspense fallback={<DelayedLoading />}>
      <SceneComponent {...params} />
    </Suspense>
  )
}

export function LoggedOutApp() {
  const { scene, params } = useValues(sceneLogic)
  const SceneComponent: (() => JSX.Element) | LazyExoticComponent<any> =
    scenes[scene as keyof typeof scenes] || scenes.error404

  return (
    <Suspense fallback={<DelayedLoading />}>
      <SceneComponent {...params} />
    </Suspense>
  )
}

export function App() {
  const { scene, params } = useValues(sceneLogic)
  if (scene === 'login' || scene === 'signup') {
    return <LoggedOutApp />
  }
  return <LoggedInApp />
}
