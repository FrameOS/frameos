import { actions, kea, path, reducers, type MakeLogicType } from 'kea'
import { urlToAction } from 'kea-router'

import { getRoutes } from './scenes'

type SceneParams = Record<string, string>

interface SceneLogicValues {
  scene: string | null
  params: SceneParams
}

interface SceneLogicActions {
  setScene: (scene: string, params?: SceneParams) => { scene: string; params?: SceneParams }
}

// This package runs no kea-typegen (frontend/ does; its inline types travel
// with the components it exports), so the logic type is written by hand.
export type sceneLogicType = MakeLogicType<SceneLogicValues, SceneLogicActions>

// kea-router hands over every path segment, optional ones as undefined; the
// scenes only ever read the ones the route matched.
function matchedParams(params: Record<string, string | undefined>): SceneParams {
  return Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

export const sceneLogic = kea<sceneLogicType>([
  path(['cloud', 'frontend', 'sceneLogic']),
  actions({
    setScene: (scene: string, params?: SceneParams) => ({ scene, params }),
  }),
  reducers({
    scene: [
      null as string | null,
      {
        setScene: (_, payload) => payload.scene,
      },
    ],
    params: [
      {} as SceneParams,
      {
        setScene: (_, payload) => payload.params || {},
      },
    ],
  }),
  urlToAction(({ actions }) => {
    return Object.fromEntries(
      Object.entries(getRoutes()).map(([routePath, scene]) => {
        return [routePath, (params: Record<string, string | undefined>) => actions.setScene(scene, matchedParams(params))]
      })
    )
  }),
])
