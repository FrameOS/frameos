import type { ComponentType } from 'react'
import { urls } from '../urls'
import { getRouteBasePath } from '../utils/getBasePath'
import { isInFrameAdminMode } from '../utils/frameAdmin'
import { isCloudMode } from '../utils/cloudMode'

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

// kea-router takes the FIRST pattern that matches, so the literal routes are
// registered before the parametric /frames/:id ones. Self-hosted that is
// moot (/settings and /frames/:id never overlap), but on the cloud the SPA is
// mounted AT /frames, and /frames/:id would swallow /frames/apps and
// /frames/:frameId/scenes: sceneLogic then reported scene "frame" on the apps
// page, and the shell's rail — which compares that scene with the mode the
// rendered page passed it — showed the Frame button as forever pending.
//
// The settings scene is not registered at all where it never renders: on the
// cloud the settings page is an account page (urls.settings() links out to
// it), and in frame-admin mode urls.settings() IS a frame tool path
// (/frames/<id>/settings) that the frame scene renders.
export const getRoutes = () =>
  ({
    ...(getRouteBasePath() ? { [getRouteBasePath() + '/']: 'frames' } : {}),
    [urls.frames()]: isInFrameAdminMode() ? 'frame' : 'frames',
    ...(isInFrameAdminMode() || isCloudMode() ? {} : { [urls.settings()]: 'settings' }),
    [urls.scenes()]: 'sceneWorkspace',
    [urls.scenes(':frameId')]: 'sceneWorkspace',
    [urls.scenes(':frameId', ':sceneId')]: 'sceneWorkspace',
    [urls.apps()]: 'appsWorkspace',
    [urls.apps(':frameId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId', ':nodeId')]: 'appsWorkspace',
    [urls.login()]: 'login',
    [urls.signup()]: 'signup',
    [urls.setupUnavailable()]: 'setupUnavailable',
    [urls.frame(':id')]: 'frame',
    [urls.frame(':id', ':tool')]: 'frame',
  }) as const
