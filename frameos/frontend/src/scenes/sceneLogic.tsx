import { actions, kea, path, reducers } from 'kea'
import { urlToAction } from 'kea-router'

import { getRoutes } from './scenes'

export const sceneLogic = kea([
  path(['frameos', 'frontend', 'sceneLogic']),
  actions({
    setScene: (scene: string, params?: Record<string, string>) => ({ scene, params }),
  }),
  reducers({
    scene: [
      null as string | null,
      {
        setScene: (_, payload) => payload.scene,
      },
    ],
    params: [
      {} as Record<string, string>,
      {
        setScene: (_, payload) => payload.params || {},
      },
    ],
  }),
  urlToAction(({ actions }) => {
    return Object.fromEntries(
      Object.entries(getRoutes()).map(([routePath, scene]) => {
        return [routePath, (params: Record<string, string>) => actions.setScene(scene, params)]
      })
    )
  }),
])
