import { actions, afterMount, connect, kea, key, path, props, reducers, selectors } from 'kea'

import { AssetType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { assetsLogicType } from './assetsLogicType'
import { frameLogic } from '../../frameLogic'
import { apiFetch } from '../../../../utils/apiFetch'

export interface AssetsLogicProps {
  frameId: number
}

export const assetsLogic = kea<assetsLogicType>([
  path(['src', 'scenes', 'frame', 'assetsLogic']),
  props({} as AssetsLogicProps),
  connect(({ frameId }: AssetsLogicProps) => ({ logic: [socketLogic], values: [frameLogic({ frameId }), ['frame']] })),
  key((props) => props.frameId),
  actions({
    setSortKey: (sortKey: string) => ({ sortKey }),
  }),
  reducers({
    sortKey: [
      'path',
      {
        setSortKey: (_, { sortKey }) => sortKey,
      },
    ],
  }),
  loaders(({ props }) => ({
    assets: [
      [] as AssetType[],
      {
        loadAssets: async () => {
          try {
            const response = await apiFetch(`/api/frames/${props.frameId}/assets`)
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
      (s) => [s.assets, s.frame, s.sortKey],
      (assets, frame, sortKey) => {
        const assetsPath = frame.assets_path ?? '/srv/assets'
        const cleanedAssets = assets.map((asset) => ({
          ...asset,
          path: asset.path.startsWith(assetsPath + '/') ? '.' + asset.path.substring(assetsPath.length) : asset.path,
        }))
        const sorter: (a: any, b: any) => number =
          sortKey === 'path'
            ? (a, b) => a.path.localeCompare(b.path)
            : sortKey === '-path'
            ? (a, b) => b.path.localeCompare(a.path)
            : sortKey === 'size'
            ? (a, b) => a.size - b.size
            : sortKey === '-size'
            ? (a, b) => b.size - a.size
            : sortKey === 'mtime'
            ? (a, b) => a.mtime - b.mtime
            : sortKey === '-mtime'
            ? (a, b) => b.mtime - a.mtime
            : () => 0
        cleanedAssets.sort(sorter)
        return cleanedAssets
      },
    ],
  }),
  afterMount(({ actions, cache }) => {
    actions.loadAssets()
  }),
])
