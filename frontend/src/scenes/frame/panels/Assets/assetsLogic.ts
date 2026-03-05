import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { AssetType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { assetsLogicType } from './assetsLogicType'
import { frameLogic } from '../../frameLogic'
import { apiFetch } from '../../../../utils/apiFetch'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { blobToDataUrl } from '../../../../utils/fileDataUrl'
import { frameAssetsApiPath } from '../../../../utils/frameAssetsApi'

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

function buildAssetTree(assets: AssetType[], rootName: string): AssetNode {
  const root: AssetNode = {
    name: rootName,
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

function normalizeAssetsPath(assetsPath?: string): string {
  let normalizedPath = (assetsPath || '/srv/assets').replace(/\/+$/, '') || '/srv/assets'
  while (normalizedPath.startsWith('./')) {
    normalizedPath = normalizedPath.slice(2)
  }
  return normalizedPath || '.'
}

function normalizeAssetPath(path: string, assetsPath?: string): string {
  const rawAssetsPath = (assetsPath || '/srv/assets').replace(/\/+$/, '') || '/srv/assets'
  const normalizedAssetsPath = normalizeAssetsPath(assetsPath)
  if (!path) {
    return normalizedAssetsPath
  }
  if (
    path === rawAssetsPath ||
    path.startsWith(`${rawAssetsPath}/`) ||
    path === normalizedAssetsPath ||
    path.startsWith(`${normalizedAssetsPath}/`)
  ) {
    return path
  }
  if (path.startsWith('/')) {
    return path
  }
  const normalizedPath = path.replace(/^\.\/+/, '').replace(/^\/+/, '')
  return normalizedPath ? `${normalizedAssetsPath}/${normalizedPath}` : normalizedAssetsPath
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
            const response = await apiFetch(frameAssetsApiPath(props.frameId))
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
          if (isInFrameAdminMode()) {
            return true
          }
          try {
            const response = await apiFetch(frameAssetsApiPath(props.frameId, 'assets/sync'), {
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
        const normalizedAssetsPath = normalizeAssetsPath(assetsPath)
        const cleanedAssets = assets.map((asset) => ({
          ...asset,
          path: asset.path.startsWith(`${assetsPath}/`)
            ? '.' + asset.path.substring(assetsPath.length)
            : asset.path.startsWith(`${normalizedAssetsPath}/`)
            ? '.' + asset.path.substring(normalizedAssetsPath.length)
            : asset.path === assetsPath || asset.path === normalizedAssetsPath
            ? '.'
            : asset.path,
        }))
        cleanedAssets.sort((a, b) => a.path.localeCompare(b.path))
        return cleanedAssets
      },
    ],
    assetTree: [
      (s) => [s.cleanedAssets, s.frame],
      (cleanedAssets, frame) => {
        return buildAssetTree(cleanedAssets, frame.assets_path ?? '/srv/assets')
      },
    ],
  }),
  listeners(({ actions, props, values }) => ({
    uploadDroppedFiles: async ({ path, files }) => {
      const assetsPath = values.frame.assets_path ?? '/srv/assets'
      const uploadedFiles = files.map((file) =>
        normalizeAssetPath(`${path ? path + '/' : ''}${file.name}`, assetsPath)
      )
      actions.filesToUpload(uploadedFiles)
      for (const file of files) {
        const uploadPath = frameAssetsApiPath(props.frameId, 'assets/upload')
        try {
          const response = isInFrameAdminMode()
            ? await apiFetch(uploadPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  path,
                  filename: file.name,
                  data_url: await blobToDataUrl(file),
                }),
              })
            : await (() => {
                const formData = new FormData()
                formData.append('file', file)
                formData.append('path', path)
                return apiFetch(uploadPath, {
                  method: 'POST',
                  body: formData,
                })
              })()
          if (!response.ok) {
            throw new Error('Failed to upload asset')
          }
          const asset = await response.json()
          actions.assetUploaded({
            ...asset,
            path: normalizeAssetPath(asset.path, assetsPath),
          })
        } catch (error) {
          actions.uploadFailure(normalizeAssetPath(`${path ? path + '/' : ''}${file.name}`, assetsPath))
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
        const response = await apiFetch(frameAssetsApiPath(props.frameId, 'assets/delete'), {
          method: 'POST',
          body: new URLSearchParams({ path }),
        })
        if (!response.ok) {
          throw new Error('Failed to delete asset')
        }
        actions.assetDeleted(normalizeAssetPath(path, values.frame.assets_path))
      } catch (error) {
        console.error(error)
      }
    },
    renameAsset: async ({ oldPath, newPath }) => {
      try {
        const response = await apiFetch(frameAssetsApiPath(props.frameId, 'assets/rename'), {
          method: 'POST',
          body: new URLSearchParams({ src: oldPath, dst: newPath }),
        })
        if (!response.ok) {
          throw new Error('Failed to rename asset')
        }
        actions.assetRenamed(
          normalizeAssetPath(oldPath, values.frame.assets_path),
          normalizeAssetPath(newPath, values.frame.assets_path)
        )
      } catch (error) {
        console.error(error)
      }
    },
    createFolder: async ({ path }) => {
      try {
        const response = await apiFetch(frameAssetsApiPath(props.frameId, 'assets/mkdir'), {
          method: 'POST',
          body: new URLSearchParams({ path }),
        })
        if (!response.ok) {
          throw new Error('Failed to create folder')
        }
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
      assetDeleted: (state, { path }) => state.filter((a) => a.path !== path && !a.path.startsWith(`${path}/`)),
      assetRenamed: (state, { oldPath, newPath }) => {
        return state.map((a) =>
          a.path === oldPath
            ? { ...a, path: newPath }
            : a.path.startsWith(`${oldPath}/`)
            ? { ...a, path: `${newPath}${a.path.slice(oldPath.length)}` }
            : a
        )
      },
    },
  }),
])
