import { actions, kea, path, reducers } from 'kea'

import type { sceneLogicType } from './sceneLogicType'
import { urlToAction } from 'kea-router'
import { routes, scenes } from './scenes'

export const sceneLogic = kea<sceneLogicType>([
  path(['src', 'sceneLogic']),
  actions({
    setScene: (scene, params) => ({ scene, params }),
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
])
