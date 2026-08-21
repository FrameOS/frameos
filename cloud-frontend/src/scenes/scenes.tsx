import { lazy } from 'react'

import { urls } from '../../../frontend/src/urls'

export const scenes = {
  error404: () => <div>404</div>,
  frames: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudFramesHome }))),
  frame: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudFrame }))),
  sceneWorkspace: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudSceneWorkspace }))),
  appsWorkspace: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudAppsWorkspace }))),
  settings: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudSettings }))),
}

// Routes come from the shared urls module so they always match the links
// the shared components generate. With route_base_path = '/frames' these
// resolve to /frames, /frames/:id, /frames/:id/scenes/..., /frames/apps/...
// and /frames/settings (the account's service API keys). kea-router takes
// the first matching pattern, so the literal /frames/* routes come before
// the parametric /frames/:id.
// The SPA's own login/signup scenes are deliberately absent: Next.js owns
// auth on the cloud (apiFetch redirects to /login on 401).
export const getRoutes = () =>
  ({
    [urls.frames()]: 'frames',
    [urls.frames() + '/']: 'frames',
    [urls.settings()]: 'settings',
    [urls.scenes()]: 'sceneWorkspace',
    [urls.apps()]: 'appsWorkspace',
    [urls.apps(':frameId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId', ':nodeId')]: 'appsWorkspace',
    [urls.scenes(':frameId')]: 'sceneWorkspace',
    [urls.scenes(':frameId', ':sceneId')]: 'sceneWorkspace',
    [urls.frame(':id')]: 'frame',
    [urls.frame(':id', ':tool')]: 'frame',
  } as const)
