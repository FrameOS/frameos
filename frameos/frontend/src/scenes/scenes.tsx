import { lazy } from 'react'

export const scenes = {
  error404: () => <div>404</div>,
  image: lazy(() => import('./image/Image')),
  admin: lazy(() => import('./admin/Admin')),
  login: lazy(() => import('./login/Login')),
}

export const getRoutes = () =>
  ({
    '/': 'image',
    '/index.html': 'image',
    '/admin': 'admin',
    '/login': 'login',
    '/logout': 'login',
  }) as const
