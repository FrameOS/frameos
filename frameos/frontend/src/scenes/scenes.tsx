import { lazy } from 'react'

export const scenes = {
  error404: () => <div>404</div>,
  image: lazy(() => import('./image/Image')),
  admin: lazy(() => import('./admin/Admin')),
  adminScenes: lazy(() => import('./admin/AdminScenes')),
  adminApps: lazy(() => import('./admin/AdminApps')),
  login: lazy(() => import('./login/Login')),
}

export const getRoutes = () =>
  ({
    '/': 'image',
    '/index.html': 'image',
    '/admin': 'admin',
    '/admin/scenes': 'adminScenes',
    '/admin/scenes/:frameId': 'adminScenes',
    '/admin/scenes/:frameId/:sceneId': 'adminScenes',
    '/admin/apps': 'adminApps',
    '/admin/apps/:frameId': 'adminApps',
    '/admin/apps/:frameId/:sceneId': 'adminApps',
    '/admin/apps/:frameId/:sceneId/:nodeId': 'adminApps',
    '/login': 'login',
    '/logout': 'login',
  }) as const
