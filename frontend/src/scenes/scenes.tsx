import type { ComponentType } from 'react'
import { urls } from '../urls'
import { getRouteBasePath } from '../utils/getBasePath'
import { isInFrameAdminMode } from '../utils/frameAdmin'
import { cloudSignedIn, isCloudMode } from '../utils/cloudMode'
import { NotFound } from './NotFound'

export type SceneComponent = ComponentType<Record<string, any>>

// One 404 for every shell — see NotFound.tsx. Kept under this name so the
// scene table and App.tsx's load-failure fallback keep their imports.
export const Error404 = NotFound

const sceneLoaders = {
  // The home page behind the rail's logo (hello, recent frames, scenes and
  // albums, usage); the on-device admin panel never routes to it.
  home: () => import('./home/Home'),
  // The signed-out scene store (the cloud's /store, the scenes host's root).
  storeFront: () => import('./store/PublicStoreFront'),
  frames: () => import('./frames/Frames'),
  frame: () => import('./frame/Frame'),
  sceneWorkspace: () => import('./workspace/SceneWorkspace'),
  appsWorkspace: () => import('./workspace/AppsWorkspace'),
  photosWorkspace: () => import('./photos/PhotosWorkspace'),
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
// The settings scene is one page of anchored sections self-hosted and a set
// of pages on the cloud (/account/<page>, outside the /frames mount; see
// settings/account/accountPages.ts). It is not registered in frame-admin
// mode, where urls.settings() IS a frame tool path (/frames/<id>/settings)
// that the frame scene renders.
export const getRoutes = () =>
  ({
    ...(getRouteBasePath() ? { [getRouteBasePath() + '/']: 'frames' } : {}),
    ...(isCloudMode() ? { [urls.home()]: 'home', [urls.store()]: 'storeFront', '/': 'storeFront' } : {}),
    ...(isCloudMode() || isInFrameAdminMode() ? {} : { [urls.home()]: 'home' }),
    [urls.frames()]: isInFrameAdminMode() ? 'frame' : 'frames',
    ...(isInFrameAdminMode()
      ? {}
      : isCloudMode()
      ? { [urls.settings()]: 'settings', [urls.settings(':page')]: 'settings' }
      : { [urls.settings()]: 'settings' }),
    [urls.scenes()]: 'sceneWorkspace',
    // Signed out, the cloud's /scenes is the public store, not the workspace.
    ...(isCloudMode() && !cloudSignedIn() ? { [urls.scenes()]: 'storeFront' } : {}),
    [urls.scenes(':frameId')]: 'sceneWorkspace',
    [urls.scenes(':frameId', ':sceneId')]: 'sceneWorkspace',
    [urls.apps()]: 'appsWorkspace',
    [urls.apps(':frameId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId', ':nodeId')]: 'appsWorkspace',
    // On the cloud the system apps have routes of their own (/apps and
    // /apps/system/<keyword>, beside /apps/frames/…); self-hosted they are
    // the frame routes with "system" in the frame's place.
    ...(isCloudMode()
      ? {
          [urls.appsHome()]: 'appsWorkspace',
          [urls.systemApps()]: 'appsWorkspace',
          [urls.systemApps(':keyword')]: 'appsWorkspace',
        }
      : {}),
    // The on-device admin panel is one frame; the library lives on a control plane.
    ...(isInFrameAdminMode() ? {} : { [urls.photos()]: 'photosWorkspace' }),
    [urls.login()]: 'login',
    [urls.signup()]: 'signup',
    [urls.setupUnavailable()]: 'setupUnavailable',
    [urls.frame(':id')]: 'frame',
    [urls.frame(':id', ':tool')]: 'frame',
  } as const)
