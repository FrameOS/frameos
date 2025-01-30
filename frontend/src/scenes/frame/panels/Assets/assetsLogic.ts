import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { AssetType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { assetsLogicType } from './assetsLogicType'
import { frameLogic } from '../../frameLogic'
import { apiFetch } from '../../../../utils/apiFetch'

export interface AssetsLogicProps {
  frameId: number
}

export interface AssetNode {
  name: string
  path: string
  isFolder: boolean
  size?: number
  mtime?: number
  children: Record<string, AssetNode>
}

function buildAssetTree(assets: AssetType[]): AssetNode {
  const root: AssetNode = {
    name: '/srv/assets',
    path: '',
    isFolder: true,
    children: {},
  }

  for (const asset of assets) {
    let normalizedPath = asset.path.startsWith('./') ? asset.path.slice(2) : asset.path
    const parts = normalizedPath.split('/').filter(Boolean)

    let currentNode = root

    // Traverse or build the tree structure
    parts.forEach((part, index) => {
      if (!currentNode.children[part]) {
        currentNode.children[part] = {
          name: part,
          path: parts.slice(0, index + 1).join('/'),
          isFolder: true,
          children: {},
        }
      }
      currentNode = currentNode.children[part]
    })

    if (Object.keys(currentNode.children).length === 0) {
      currentNode.isFolder = false
    }

    currentNode.size = asset.size
    currentNode.mtime = asset.mtime
  }
  return root
}

export const assetsLogic = kea<assetsLogicType>([
  path(['src', 'scenes', 'frame', 'assetsLogic']),
  props({} as AssetsLogicProps),
  connect(({ frameId }: AssetsLogicProps) => ({ logic: [socketLogic], values: [frameLogic({ frameId }), ['frame']] })),
  key((props) => props.frameId),
  actions({
    uploadAssets: (path: string) => ({ path }),
    assetUploaded: (asset: AssetType) => ({ asset }),
    syncAssets: true,
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
    assetSync: [
      false,
      {
        syncAssets: async () => {
          try {
            const response = await apiFetch(`/api/frames/${props.frameId}/assets/sync`, {
              method: 'POST',
            })
            if (!response.ok) {
              throw new Error('Failed to upload fonts')
            }
            return true
          } catch (error) {
            console.error(error)
            return false
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
        const cleanedAssets = assets.map((asset) => ({
          ...asset,
          path: asset.path.startsWith(assetsPath + '/') ? '.' + asset.path.substring(assetsPath.length) : asset.path,
        }))
        cleanedAssets.sort((a, b) => a.path.localeCompare(b.path))
        return cleanedAssets
      },
    ],
    assetTree: [
      (s) => [s.cleanedAssets],
      (cleanedAssets) => {
        return buildAssetTree(cleanedAssets)
      },
    ],
  }),
  listeners(({ actions, props }) => ({
    uploadAssets: async ({ path }) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.onchange = async () => {
        const files = Array.from(input.files || [])
        for (const file of files) {
          const formData = new FormData()
          formData.append('file', file)
          formData.append('path', path)
          const response = await apiFetch(`/api/frames/${props.frameId}/assets/upload`, {
            method: 'POST',
            body: formData,
          })
          const asset = await response.json()
          actions.assetUploaded(asset)
        }
      }
      input.click()
    },
  })),
  reducers({
    assets: {
      assetUploaded: (state, { asset }) => [...state, asset],
    },
  }),
  afterMount(({ actions }) => {
    actions.loadAssets()
  }),
])
