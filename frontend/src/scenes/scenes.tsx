import { lazy } from 'react'
import { urls } from '../urls'
import { getBasePath } from '../utils/getBasePath'

export const scenes = {
  error404: () => <div>404</div>,
  frames: lazy(() => import('./frames/Frames')),
  frame: lazy(() => import('./frame/Frame')),
  settings: lazy(() => import('./settings/Settings')),
  login: lazy(() => import('./login/Login')),
  signup: lazy(() => import('./signup/Signup')),
}

export const getRoutes = () =>
  ({
    ...(getBasePath() ? { [getBasePath() + '/']: 'frames' } : {}),
    [urls.frames()]: 'frames',
    [urls.frame(':id')]: 'frame',
    [urls.settings()]: 'settings',
    [urls.login()]: 'login',
    [urls.signup()]: 'signup',
  } as const)
