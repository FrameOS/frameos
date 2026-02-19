import { lazy } from 'react'

export const scenes = {
  error404: () => <div>404</div>,
  image: lazy(() => import('./image/Image')),
  root: lazy(() => import('./root/Root')),
  admin: lazy(() => import('./control/Control')),
  login: lazy(() => import('./login/Login')),
}

export const getRoutes = () =>
  ({
    '/': 'image',
    '/index.html': 'image',
    '/new': 'root',
    '/new/': 'root',
    '/new/root': 'root',
    '/admin': 'admin',
    '/control': 'admin',
    '/login': 'login',
    '/logout': 'login',
  }) as const
