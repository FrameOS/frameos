import { actions, kea, listeners, path, reducers } from 'kea'

import type { sceneLogicType } from './sceneLogicType'
import { urlToAction } from 'kea-router'
import { getRoutes } from './scenes'
import { getBasePath } from '../utils/getBasePath'
import { urls } from '../urls'
import { inHassioIngress } from '../utils/inHassioIngress'

// Note: this should not connect to any other logic that pulls in data, as it's used even when the user is not logged in
export const sceneLogic = kea<sceneLogicType>([
  path(['src', 'sceneLogic']),
  actions({
    setScene: (scene, params) => ({ scene, params }),
    logout: true,
  }),
  reducers(() => ({
    basePath: [getBasePath(), {}],
    isHassioIngress: [inHassioIngress(), {}],
    scene: [
      null as string | null,
      {
        setScene: (_, payload) => payload.scene,
      },
    ],
    params: [
      {},
      {
        setScene: (_, payload) => payload.params || {},
      },
    ],
  })),
  urlToAction(({ actions }) => {
    return Object.fromEntries(
      Object.entries(getRoutes()).map(([path, scene]) => {
        return [path, (params) => actions.setScene(scene, params)]
      })
    )
  }),
  listeners(({ actions }) => ({
    logout: async () => {
      try {
        await fetch('/api/logout', { method: 'POST' })
      } catch (error) {
        console.error('Logout failed', error)
      }
      location.href = urls.frames()
    },
  })),
])
