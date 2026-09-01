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
// resolve to /frames, /frames/:id, /frames/:id/scenes/... and
// /frames/apps/... kea-router takes the first matching pattern, so the
// literal /frames/* routes come before the parametric /frames/:id.
// The SPA's own login/signup scenes are deliberately absent: Next.js owns
// auth on the cloud (apiFetch redirects to /login on 401). So is the
// settings scene: the account's service API keys and SSH keys are an
// account page (/account/settings), and urls.settings() links out to it;
// the old /frames/settings is redirected there server-side.
export const getRoutes = () =>
  ({
    [urls.frames()]: 'frames',
    [urls.frames() + '/']: 'frames',
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
