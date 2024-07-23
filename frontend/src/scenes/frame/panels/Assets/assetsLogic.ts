import { actions, afterMount, connect, kea, key, path, props, reducers } from 'kea'

import { AssetType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { assetsLogicType } from './assetsLogicType'

export interface assetsLogicProps {
  frameId: number
}

export const assetsLogic = kea<assetsLogicType>([
  path(['src', 'scenes', 'frame', 'assetsLogic']),
  props({} as assetsLogicProps),
  connect({ logic: [socketLogic] }),
  key((props) => props.frameId),
  loaders(({ props }) => ({
    assets: [
      [] as AssetType[],
      {
        loadAssets: async () => {
          try {
            const response = await fetch(`/api/frames/${props.frameId}/assets`)
            if (!response.ok) {
              throw new Error('Failed to fetch assets')
            }
            const data = await response.json()
            return data.assets as AssetType[]
          } catch (error) {
            console.error(error)
            return []
          }
        },
      },
    ],
  })),
  afterMount(({ actions, cache }) => {
    actions.loadAssets()
  }),
])
