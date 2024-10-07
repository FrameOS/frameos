import { actions, afterMount, connect, kea, key, path, props, reducers, selectors } from 'kea'

import { AssetType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { assetsLogicType } from './assetsLogicType'
import { frameLogic } from '../../frameLogic'

export interface AssetsLogicProps {
  frameId: number
}

export const assetsLogic = kea<assetsLogicType>([
  path(['src', 'scenes', 'frame', 'assetsLogic']),
  props({} as AssetsLogicProps),
  connect(({ frameId }: AssetsLogicProps) => ({ logic: [socketLogic], values: [frameLogic({ frameId }), ['frame']] })),
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
  selectors({
    cleanedAssets: [
      (s) => [s.assets, s.frame],
      (assets, frame) => {
        const assetsPath = frame.assets_path ?? '/srv/assets'
        return assets.map((asset) => ({
          ...asset,
          path: asset.path.startsWith(assetsPath + '/') ? asset.path.substring(assetsPath.length + 1) : asset.path,
        }))
      },
    ],
  }),
  afterMount(({ actions, cache }) => {
    actions.loadAssets()
  }),
])
