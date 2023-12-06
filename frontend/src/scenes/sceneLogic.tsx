import { actions, kea, listeners, path, reducers } from 'kea'

import type { sceneLogicType } from './sceneLogicType'
import { urlToAction } from 'kea-router'
import { routes } from './scenes'

export const sceneLogic = kea<sceneLogicType>([
  path(['src', 'sceneLogic']),
  actions({
    setScene: (scene, params) => ({ scene, params }),
    logout: true,
  }),
  reducers({
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
  }),
  urlToAction(({ actions }) => {
    return Object.fromEntries(
      Object.entries(routes).map(([path, scene]) => {
        return [path, (params) => actions.setScene(scene, params)]
      })
    )
  }),
  listeners(({ actions }) => ({
    logout: async () => {
      await fetch('/api/logout', { method: 'POST' })
      location.href = '/login'
    },
  })),
])
