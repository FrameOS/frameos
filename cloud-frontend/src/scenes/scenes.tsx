import { lazy } from 'react'

import { urls } from '../../../frontend/src/urls'

export const scenes = {
  error404: () => <div>404</div>,
  frames: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudFramesHome }))),
  frame: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudFrame }))),
  sceneWorkspace: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudSceneWorkspace }))),
  appsWorkspace: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudAppsWorkspace }))),
}

// Routes come from the shared urls module so they always match the links
// the shared components generate. With route_base_path = '/frames' these
// resolve to /frames, /frames/frames/:id, /frames/scenes/..., /frames/apps/...
// The SPA's own login/signup scenes are deliberately absent: Next.js owns
// auth on the cloud (apiFetch redirects to /login on 401).
export const getRoutes = () =>
  ({
    [urls.frames()]: 'frames',
    [urls.frames() + '/']: 'frames',
    [urls.frame(':id')]: 'frame',
    [urls.scenes()]: 'sceneWorkspace',
    [urls.scenes(':frameId')]: 'sceneWorkspace',
    [urls.scenes(':frameId', ':sceneId')]: 'sceneWorkspace',
    [urls.apps()]: 'appsWorkspace',
    [urls.apps(':frameId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId', ':nodeId')]: 'appsWorkspace',
  }) as const
