import { lazy } from 'react'
import { urls } from '../urls'

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
    [urls.frames()]: 'frames',
    [urls.frame(':id')]: 'frame',
    [urls.settings()]: 'settings',
    '/login': 'login',
    '/signup': 'signup',
  } as const)
