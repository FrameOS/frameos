import { lazy } from 'react'

import { urls } from '../../../frontend/src/urls'
import { NotFound } from '../../../frontend/src/scenes/NotFound'

export const scenes = {
  error404: NotFound,
  frames: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudFramesHome }))),
  frame: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudFrame }))),
  sceneWorkspace: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudSceneWorkspace }))),
  appsWorkspace: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudAppsWorkspace }))),
  photosWorkspace: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudPhotosWorkspace }))),
  settings: lazy(() => import('./cloud/Cloud').then((module) => ({ default: module.CloudSettings }))),
}

// Routes come from the shared urls module so they always match the links
// the shared components generate. With route_base_path = '/frames' these
// resolve to /frames, /frames/:id, /frames/:id/scenes/... and
// /frames/apps/... kea-router takes the first matching pattern, so the
// literal /frames/* routes come before the parametric /frames/:id.
// The SPA's own login/signup scenes are deliberately absent: Next.js owns
// auth on the cloud (apiFetch redirects to /login on 401). The settings
// scene is the account's pages — backends, service keys, SSH keys, usage,
// backups, activity, security, developer — one route each under /account
// (frontend/src/scenes/settings/account/accountPages.ts), the address they
// had as Next.js pages. That is outside the /frames mount, so Next serves
// this shell at /account/** too (app/account/[[...section]]/route.ts).
export const getRoutes = () =>
  ({
    [urls.frames()]: 'frames',
    [urls.frames() + '/']: 'frames',
    [urls.settings()]: 'settings',
    [urls.settings(':page')]: 'settings',
    [urls.scenes()]: 'sceneWorkspace',
    [urls.apps()]: 'appsWorkspace',
    [urls.apps(':frameId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId')]: 'appsWorkspace',
    [urls.apps(':frameId', ':sceneId', ':nodeId')]: 'appsWorkspace',
    [urls.photos()]: 'photosWorkspace',
    [urls.scenes(':frameId')]: 'sceneWorkspace',
    [urls.scenes(':frameId', ':sceneId')]: 'sceneWorkspace',
    [urls.frame(':id')]: 'frame',
    [urls.frame(':id', ':tool')]: 'frame',
  } as const)
