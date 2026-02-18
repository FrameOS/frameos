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

    if (!asset.is_dir && Object.keys(currentNode.children).length === 0) {
      currentNode.isFolder = false
    } else {
      currentNode.isFolder = true
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
    uploadDroppedFiles: (path: string, files: File[]) => ({ path, files }),
    assetUploaded: (asset: AssetType) => ({ asset }),
    filesToUpload: (files: string[]) => ({ files }),
    uploadFailure: (path: string) => ({ path }),
    syncAssets: true,
    deleteAsset: (path: string) => ({ path }),
    assetDeleted: (path: string) => ({ path }),
    renameAsset: (oldPath: string, newPath: string) => ({ oldPath, newPath }),
    assetRenamed: (oldPath: string, newPath: string) => ({ oldPath, newPath }),
    createFolder: (path: string) => ({ path }),
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
  listeners(({ actions, props, values }) => ({
    uploadDroppedFiles: async ({ path, files }) => {
      const uploadedFiles = files.map((file) => `${path ? path + '/' : ''}${file.name}`)
      actions.filesToUpload(uploadedFiles)
      for (const file of files) {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('path', path)
        try {
          const response = await apiFetch(`/api/frames/${props.frameId}/assets/upload`, {
            method: 'POST',
            body: formData,
          })
          const asset = await response.json()
          actions.assetUploaded(asset)
        } catch (error) {
          actions.uploadFailure(`${path ? path + '/' : ''}${file.name}`)
        }
      }
    },
    uploadAssets: async ({ path }) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.onchange = async () => {
        const files = Array.from(input.files || [])
        actions.uploadDroppedFiles(path, files)
      }
      input.click()
    },
    deleteAsset: async ({ path }) => {
      try {
        await apiFetch(`/api/frames/${props.frameId}/assets/delete`, {
          method: 'POST',
          body: new URLSearchParams({ path }),
        })
        const assetsPath = values.frame.assets_path ?? '/srv/assets'
        actions.assetDeleted(assetsPath + '/' + path)
      } catch (error) {
        console.error(error)
      }
    },
    renameAsset: async ({ oldPath, newPath }) => {
      try {
        await apiFetch(`/api/frames/${props.frameId}/assets/rename`, {
          method: 'POST',
          body: new URLSearchParams({ src: oldPath, dst: newPath }),
        })
        const assetsPath = values.frame.assets_path ?? '/srv/assets'
        actions.assetRenamed(assetsPath + '/' + oldPath, assetsPath + '/' + newPath)
      } catch (error) {
        console.error(error)
      }
    },
    createFolder: async ({ path }) => {
      try {
        await apiFetch(`/api/frames/${props.frameId}/assets/mkdir`, {
          method: 'POST',
          body: new URLSearchParams({ path }),
        })
        actions.loadAssets()
      } catch (error) {
        console.error(error)
      }
    },
  })),
  reducers({
    assets: {
      assetUploaded: (state, { asset }) =>
        state.find((a) => a.path === asset.path)
          ? state.map((a) => (a.path === asset.path ? asset : a))
          : [...state, asset],
      filesToUpload: (state, { files }) => {
        const foundFiles: Set<string> = new Set()
        const updatedFiles = state.map((asset) => {
          if (files.includes(asset.path)) {
            foundFiles.add(asset.path)
            return { ...asset, size: -1, mtime: -1 }
          }
          return asset
        })
        for (const file of files) {
          if (!foundFiles.has(file)) {
            updatedFiles.push({ path: file, size: -1, mtime: -1 })
          }
        }
        return updatedFiles
      },
      uploadFailure: (state, { path }) =>
        state.map((asset) => (asset.path === path ? { ...asset, size: -2, mtime: -2 } : asset)),
      assetDeleted: (state, { path }) => state.filter((a) => a.path !== path),
      assetRenamed: (state, { oldPath, newPath }) => {
        return state.map((a) => (a.path === oldPath ? { ...a, path: newPath } : a))
      },
    },
  }),
])
