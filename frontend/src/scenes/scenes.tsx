import type { ComponentType } from 'react'
import { urls } from '../urls'
import { getBasePath } from '../utils/getBasePath'
import { isInFrameAdminMode } from '../utils/frameAdmin'

export type SceneComponent = ComponentType<Record<string, any>>

export function Error404(): JSX.Element {
  return <div>404</div>
}

const sceneLoaders = {
  frames: () => import('./frames/Frames'),
  frame: () => import('./frame/Frame'),
  sceneWorkspace: () => import('./workspace/SceneWorkspace'),
  appsWorkspace: () => import('./workspace/AppsWorkspace'),
  settings: () => import('./settings/Settings'),
  login: () => import('./login/Login'),
  signup: () => import('./signup/Signup'),
  setupUnavailable: () => import('./auth/SetupUnavailable'),
}

export type LoadableSceneKey = keyof typeof sceneLoaders
export type SceneKey = LoadableSceneKey | 'error404'

const sceneComponentCache: Partial<Record<SceneKey, SceneComponent>> = {
  error404: Error404,
}
const sceneComponentPromises: Partial<Record<LoadableSceneKey, Promise<SceneComponent>>> = {}

export function isLoadableSceneKey(scene: string | null | undefined): scene is LoadableSceneKey {
  return typeof scene === 'string' && scene in sceneLoaders
}

export function normalizeSceneKey(scene: string | null | undefined): SceneKey {
  return isLoadableSceneKey(scene) ? scene : 'error404'
}

export function getCachedSceneComponent(scene: SceneKey): SceneComponent | null {
  return sceneComponentCache[scene] ?? null
}

export function loadSceneComponent(scene: SceneKey): Promise<SceneComponent> {
  const cachedComponent = getCachedSceneComponent(scene)
  if (cachedComponent) {
    return Promise.resolve(cachedComponent)
  }

  if (scene === 'error404') {
    return Promise.resolve(Error404)
  }

  if (!sceneComponentPromises[scene]) {
    sceneComponentPromises[scene] = sceneLoaders[scene]()
      .then((module) => {
        const Component = module.default as SceneComponent
        sceneComponentCache[scene] = Component
        return Component
      })
      .catch((error) => {
        delete sceneComponentPromises[scene]
        throw error
      })
  }

  return sceneComponentPromises[scene]
}

export function preloadSceneComponent(scene: LoadableSceneKey): void {
  void loadSceneComponent(scene).catch(() => {})
}

export const getRoutes = () =>
  ({
    ...(getBasePath() ? { [getBasePath() + '/']: 'frames' } : {}),
    [urls.frames()]: isInFrameAdminMode() ? 'frame' : 'frames',
    [urls.frame(':id')]: 'frame',
    [urls.scenes()]: 'sceneWorkspace',
    [urls.scenes(':frameId')]: 'sceneWorkspace',
    [urls.scenes(':frameId', ':sceneId')]: 'sceneWorkspace',
    [urls.apps()]: 'appsWorkspace',
    [urls.apps(':frameId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId', ':nodeId')]: 'appsWorkspace',
    [urls.settings()]: 'settings',
    [urls.login()]: 'login',
    [urls.signup()]: 'signup',
    [urls.setupUnavailable()]: 'setupUnavailable',
  } as const)
