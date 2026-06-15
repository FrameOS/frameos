import { useEffect, useState } from 'react'
import { useMountedLogic, useValues } from 'kea'
import { sceneLogic } from './sceneLogic'
import {
  getCachedSceneComponent,
  loadSceneComponent,
  normalizeSceneKey,
  type SceneComponent,
  type SceneKey,
} from './scenes'
import { socketLogic } from './socketLogic'
import { framesModel } from '../models/framesModel'
import { appsModel } from '../models/appsModel'
import { fontsModel } from '../models/fontsModel'
import { templatesModel } from '../models/templatesModel'
import { entityImagesModel } from '../models/entityImagesModel'
import { longRunningTasksModel } from '../models/longRunningTasksModel'
import { embeddedUsbLogsModel } from '../models/embeddedUsbLogsModel'
import { LongRunningTaskToasts } from '../components/LongRunningTaskToasts'
import { inHassioIngress } from '../utils/inHassioIngress'
import { WorkspaceRouteLoading } from './workspace/WorkspaceRouteLoading'
import { PersistentTerminalSessions } from './frame/panels/Terminal/PersistentTerminalSessions'

interface DisplayedScene {
  scene: SceneKey
  params: Record<string, any>
  paramsKey: string
  Component: SceneComponent
}

function paramsCacheKey(params: Record<string, any>): string {
  try {
    return JSON.stringify(params)
  } catch {
    return 'unserializable'
  }
}

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

function SceneRoute({
  scene,
  params,
  fallback,
}: {
  scene: string | null
  params: Record<string, any>
  fallback: JSX.Element
}): JSX.Element {
  const sceneKey = normalizeSceneKey(scene)
  const paramsKey = paramsCacheKey(params)
  const [displayedScene, setDisplayedScene] = useState<DisplayedScene | null>(() => {
    const Component = getCachedSceneComponent(sceneKey)
    return Component ? { scene: sceneKey, params, paramsKey, Component } : null
  })
  const cachedComponent = getCachedSceneComponent(sceneKey)
  const renderedScene =
    cachedComponent &&
    (displayedScene?.scene !== sceneKey ||
      displayedScene.paramsKey !== paramsKey ||
      displayedScene.Component !== cachedComponent)
      ? { scene: sceneKey, params, paramsKey, Component: cachedComponent }
      : displayedScene

  useEffect(() => {
    let cancelled = false

    const useComponent = (Component: SceneComponent): void => {
      if (cancelled) {
        return
      }
      setDisplayedScene((current) => {
        if (current?.scene === sceneKey && current.paramsKey === paramsKey && current.Component === Component) {
          return current
        }
        return { scene: sceneKey, params, paramsKey, Component }
      })
    }

    const cachedComponent = getCachedSceneComponent(sceneKey)
    if (cachedComponent) {
      useComponent(cachedComponent)
    } else {
      void loadSceneComponent(sceneKey)
        .then(useComponent)
        .catch((error) => {
          console.error('Scene failed to load', error)
          void loadSceneComponent('error404').then(useComponent)
        })
    }

    return () => {
      cancelled = true
    }
  }, [sceneKey, paramsKey])

  if (!renderedScene) {
    return fallback
  }

  const Component = renderedScene.Component
  return <Component {...renderedScene.params} />
}

export function LoggedInApp() {
  useMountedLogic(socketLogic)
  useMountedLogic(appsModel)
  useMountedLogic(fontsModel)
  useMountedLogic(entityImagesModel)
  useMountedLogic(longRunningTasksModel)
  useMountedLogic(embeddedUsbLogsModel)
  useMountedLogic(framesModel)
  useMountedLogic(templatesModel)
  const { scene, params } = useValues(sceneLogic)

  return (
    <>
      <PersistentTerminalSessions />
      <SceneRoute scene={scene} params={params} fallback={<WorkspaceRouteLoading scene={scene} />} />
      <LongRunningTaskToasts />
    </>
  )
}

export function LoggedOutApp() {
  useMountedLogic(socketLogic)
  const { scene, params } = useValues(sceneLogic)

  return <SceneRoute scene={scene} params={params} fallback={<DelayedLoading />} />
}

export function App() {
  const { scene, params } = useValues(sceneLogic)
  if (!inHassioIngress() && (scene === 'login' || scene === 'signup' || scene === 'setupUnavailable')) {
    return <LoggedOutApp />
  }
  return <LoggedInApp />
}
