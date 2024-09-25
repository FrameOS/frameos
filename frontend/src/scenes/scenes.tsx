import { lazy } from 'react'

export const scenes = {
  error404: () => <div>404</div>,
  frames: lazy(() => import('./frames/Frames')),
  frame: lazy(() => import('./frame/Frame')),
  settings: lazy(() => import('./settings/Settings')),
  login: lazy(() => import('./login/Login')),
  signup: lazy(() => import('./signup/Signup')),
}

export const routes = {
  '/': 'frames',
  '/frames/:id': 'frame',
  '/settings': 'settings',
  '/login': 'login',
  '/signup': 'signup',
}
