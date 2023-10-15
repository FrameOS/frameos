import { lazy } from 'react'

export const scenes = {
  error404: () => <div>404</div>,
  frames: lazy(() => import('./frames/Frames')),
  frame: lazy(() => import('./frame/Frame')),
  settings: lazy(() => import('./settings/Settings')),
}

export const routes = {
  '/': 'frames',
  '/frames/:id': 'frame',
  '/settings': 'settings',
}
