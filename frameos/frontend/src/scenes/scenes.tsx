import { lazy } from 'react'

export const scenes = {
  error404: () => <div>404</div>,
  root: lazy(() => import('./root/Root')),
}

export const getRoutes = () =>
  ({
    '/new': 'root',
    '/new/': 'root',
    '/new/root': 'root',
  } as const)
