import { lazy } from 'react'
import { urls } from '../urls'
import { getBasePath } from '../utils/getBasePath'

export const scenes = {
  error404: () => <div>404</div>,
  frames: lazy(() => import('./frames/Frames')),
  frame: lazy(() => import('./frame/Frame')),
  sceneWorkspace: lazy(() => import('./workspace/SceneWorkspace')),
  appsWorkspace: lazy(() => import('./workspace/AppsWorkspace')),
  settings: lazy(() => import('./settings/Settings')),
  login: lazy(() => import('./login/Login')),
  signup: lazy(() => import('./signup/Signup')),
}

export const getRoutes = () =>
  ({
    ...(getBasePath() ? { [getBasePath() + '/']: 'frames' } : {}),
    [urls.frames()]: 'frames',
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
  } as const)
