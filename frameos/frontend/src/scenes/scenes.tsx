import { lazy } from 'react'

export const scenes = {
  error404: () => <div>404</div>,
  image: lazy(() => import('./image/Image')),
  root: lazy(() => import('./root/Root')),
  control: lazy(() => import('./control/Control')),
}

export const getRoutes = () =>
  ({
    '/': 'image',
    '/index.html': 'image',
    '/new': 'root',
    '/new/': 'root',
    '/new/root': 'root',
    '/control': 'control',
  }) as const
