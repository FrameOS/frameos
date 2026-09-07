import { lazy } from 'react'

export const scenes = {
  error404: () => <div>404</div>,
  image: lazy(() => import('./image/Image')),
  admin: lazy(() => import('./admin/Admin')),
  adminScene: lazy(() => import('./admin/Admin').then((module) => ({ default: module.AdminScene }))),
  adminApps: lazy(() => import('./admin/Admin').then((module) => ({ default: module.AdminApps }))),
  login: lazy(() => import('./login/Login')),
}

export const getRoutes = () =>
  ({
    '/': 'image',
    '/index.html': 'image',
    '/admin': 'admin',
    '/frames': 'admin',
    '/frames/:id': 'admin',
    // A hard reload of a frame tool page (/frames/1/assets): the tab lives
    // in the URL the same way it does on a backend (urls.frame(id, tool)).
    '/frames/:id/:tool': 'admin',
    '/scenes': 'adminScene',
    '/scenes/:frameId': 'adminScene',
    '/scenes/:frameId/:sceneId': 'adminScene',
    '/apps': 'adminApps',
    '/apps/:frameId': 'adminApps',
    '/apps/:frameId/:sceneId': 'adminApps',
    '/apps/:frameId/:sceneId/:nodeId': 'adminApps',
    '/settings': 'admin',
    '/login': 'login',
    '/logout': 'login',
  } as const)
