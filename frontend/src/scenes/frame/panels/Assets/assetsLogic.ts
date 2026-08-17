import { actions, afterMount, beforeUnmount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { AssetType, MetricsType, FrameId } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { assetsLogicType } from './assetsLogicType'
import { frameLogic } from '../../frameLogic'
import { metricsLogic } from '../Metrics/metricsLogic'
import { apiFetch } from '../../../../utils/apiFetch'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { isVirtualFrame, workspaceMode } from '../../../workspace/workspaceSurfaces'
import { frameAssetsApiPath } from '../../../../utils/frameAssetsApi'
import { uploadFileInChunks } from '../../../../utils/uploadFileInChunks'
import { uploadFormDataWithProgress } from '../../../../utils/uploadFormDataWithProgress'
import { longRunningTasksModel } from '../../../../models/longRunningTasksModel'
import { isHiddenOrJunkAssetPath } from '../../../../utils/hiddenFiles'
import { consumeFontSyncStream, isFontSyncStream } from '../../../../utils/fontSyncStream'

export interface AssetsLogicProps {
  frameId: FrameId
}

export interface AssetNode {
  name: string
  path: string
  isFolder: boolean
  size?: number
  mtime?: number
  children: Record<string, AssetNode>
}

export interface AssetStats {
  files: number
  folders: number
  images: number
  totalBytes: number
  latestMtime: number | null
}

export interface DiskStats {
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usedPercent: number
  // Virtual frames have no disk metrics; their stats describe the
  // backend-enforced asset quota instead.
  isQuota?: boolean
}

// Mirrors backend virtual_assets.quota_bytes: per-frame override in the
// frame settings, 100 MB default.
const VIRTUAL_ASSETS_DEFAULT_QUOTA_MB = 100

function virtualQuotaBytes(frame: { device_config?: Record<string, any> | null } | null): number {
  const raw = frame?.device_config?.assetsQuotaMb
  const parsed = typeof raw === 'string' ? parseFloat(raw) : raw
  const quotaMb =
    typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : VIRTUAL_ASSETS_DEFAULT_QUOTA_MB
  return quotaMb * 1024 * 1024
}

interface FrameAssetsResponse {
  assets: AssetType[]
  cache?: {
    refreshing?: boolean
    retry_after?: number
  }
  /** Backend shape. Only SD-backed frames report it. */
  storage?: { mounted?: boolean | null } | null
  /** The on-device admin API answers with the flag at the top level. */
  mounted?: boolean | null
}

/**
 * Whether the frame's storage is mounted, or null when nothing said either way
 * (Pi/agent frames, virtual frames, firmware older than the flag). Only an
 * explicit false is worth telling the user about: it turns "no assets" from
 * "the card is empty" into "the card is not readable".
 */
function storageMountedFromResponse(data: FrameAssetsResponse): boolean | null {
  const mounted = data.storage?.mounted ?? data.mounted
  return typeof mounted === 'boolean' ? mounted : null
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

const systemFolderNames = new Set(['.frameos', '.thumbs'])
const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '*.qoi', '.ppm', '.svg']
const normalizedImageExtensions = imageExtensions.map((extension) => extension.replace('*', '').toLowerCase())

function isSystemAssetPath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  const firstPart = normalizedPath.split('/').filter(Boolean)[0]
  return !!firstPart && systemFolderNames.has(firstPart)
}

function hasImageExtension(fileName: string): boolean {
  const normalizedName = fileName.toLowerCase()
  return normalizedImageExtensions.some((extension) => normalizedName.endsWith(extension))
}

export function isInThumbsFolder(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/')
  return (
    normalizedPath === '.thumbs' ||
    normalizedPath.endsWith('/.thumbs') ||
    normalizedPath.startsWith('.thumbs/') ||
    normalizedPath.includes('/.thumbs/')
  )
}

function collectAssetStats(node: AssetNode, isRoot = true): AssetStats {
  const stats: AssetStats = {
    files: 0,
    folders: isRoot ? 0 : 1,
    images: 0,
    totalBytes: 0,
    latestMtime: node.mtime && node.mtime > 0 ? node.mtime : null,
  }

  if (!node.isFolder) {
    stats.files = 1
    stats.folders = 0
    stats.images = hasImageExtension(node.name) && !isInThumbsFolder(node.path) ? 1 : 0
    stats.totalBytes = typeof node.size === 'number' && node.size > 0 ? node.size : 0
  }

  Object.values(node.children).forEach((child) => {
    const childStats = collectAssetStats(child, false)
    stats.files += childStats.files
    stats.folders += childStats.folders
    stats.images += childStats.images
    stats.totalBytes += childStats.totalBytes
    stats.latestMtime =
      stats.latestMtime && childStats.latestMtime
        ? Math.max(stats.latestMtime, childStats.latestMtime)
        : stats.latestMtime ?? childStats.latestMtime
  })

  return stats
}

export function nodeHasPlayableImages(node: AssetNode): boolean {
  if (isInThumbsFolder(node.path)) {
    return false
  }

  if (!node.isFolder) {
    return hasImageExtension(node.name)
  }

  return Object.values(node.children).some(nodeHasPlayableImages)
}

function latestDiskStats(metrics: MetricsType[]): DiskStats | null {
  for (let index = metrics.length - 1; index >= 0; index--) {
    const diskUsage = metrics[index].metrics?.diskUsage
    if (!diskUsage || typeof diskUsage !== 'object') {
      continue
    }

    const totalBytes = Number(diskUsage.total ?? 0)
    const availableBytes = Number(diskUsage.available ?? diskUsage.free ?? 0)
    const usedBytes = Number(diskUsage.used ?? totalBytes - availableBytes)
    const percentage = Number(diskUsage.percentage)
    if (totalBytes > 0 && Number.isFinite(usedBytes) && Number.isFinite(availableBytes)) {
      return {
        totalBytes,
        usedBytes,
        availableBytes,
        usedPercent: Number.isFinite(percentage) ? percentage : (usedBytes / totalBytes) * 100,
      }
    }
  }

  return null
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

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text()
    if (!text) {
      return fallback
    }
    try {
      const payload = JSON.parse(text) as { detail?: unknown; message?: unknown }
      return typeof payload.detail === 'string'
        ? payload.detail
        : typeof payload.message === 'string'
        ? payload.message
        : fallback
    } catch {
      return text
    }
  } catch {
    return fallback
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export const assetsLogic = kea<assetsLogicType>([
  path(['src', 'scenes', 'frame', 'assetsLogic']),
  props({} as AssetsLogicProps),
  connect(({ frameId }: AssetsLogicProps) => ({
    logic: [socketLogic],
    values: [frameLogic({ frameId }), ['frame'], metricsLogic({ frameId }), ['sortedMetrics']],
  })),
  key((props) => props.frameId),
  actions({
    uploadAssets: (path: string) => ({ path }),
    uploadDroppedFiles: (path: string, files: File[]) => ({ path, files }),
    assetUploaded: (asset: AssetType) => ({ asset }),
    filesToUpload: (files: string[]) => ({ files }),
    uploadProgress: (path: string, size: number) => ({ path, size }),
    uploadFailure: (path: string) => ({ path }),
    setAssetsRefreshing: (assetsRefreshing: boolean) => ({ assetsRefreshing }),
    setStorageMounted: (storageMounted: boolean | null) => ({ storageMounted }),
    syncAssets: true,
    deleteAsset: (path: string) => ({ path }),
    assetDeleted: (path: string) => ({ path }),
    renameAsset: (oldPath: string, newPath: string) => ({ oldPath, newPath }),
    assetRenamed: (oldPath: string, newPath: string) => ({ oldPath, newPath }),
    createFolder: (path: string) => ({ path }),
    toggleShowSystemFolders: true,
    toggleShowHiddenFiles: true,
  }),
  loaders(({ actions, cache, props, values }) => ({
    assets: [
      [] as AssetType[],
      {
        loadAssets: async () => {
          try {
            const response = await apiFetch(frameAssetsApiPath(props.frameId))
            if (!response.ok) {
              throw new Error('Failed to fetch assets')
            }
            const data = (await response.json()) as FrameAssetsResponse
            window.clearTimeout(cache.reloadTimer)
            actions.setStorageMounted(storageMountedFromResponse(data))
            if (data.cache?.refreshing) {
              const retryDelay = Math.max(1, data.cache.retry_after ?? 2) * 1000
              cache.reloadTimer = window.setTimeout(() => actions.loadAssets(), retryDelay)
            }
            actions.setAssetsRefreshing(Boolean(data.cache?.refreshing))
            // While a refresh is still in flight the server may answer with
            // an empty listing (cloud: the device has not replied yet). The
            // list already on screen is newer information than "nothing" —
            // keep it instead of blanking the panel until the reply lands.
            if (data.cache?.refreshing && data.assets.length === 0 && values.assets.length > 0) {
              return values.assets
            }
            return data.assets as AssetType[]
          } catch (error) {
            actions.setAssetsRefreshing(false)
            console.error(error)
            // A transient fetch failure must not wipe the listing.
            return values.assets
          }
        },
        refreshAssets: async () => {
          try {
            window.clearTimeout(cache.reloadTimer)
            actions.setAssetsRefreshing(true)
            const response = await apiFetch(`${frameAssetsApiPath(props.frameId)}?refresh=1`)
            if (!response.ok) {
              throw new Error('Failed to refresh assets')
            }
            const data = (await response.json()) as FrameAssetsResponse
            actions.setStorageMounted(storageMountedFromResponse(data))
            if (data.cache?.refreshing) {
              // The listing is being fetched (cloud: an assets_list command is
              // on its way to the device) — poll until it lands, exactly like
              // the initial load does.
              const retryDelay = Math.max(1, data.cache.retry_after ?? 2) * 1000
              cache.reloadTimer = window.setTimeout(() => actions.loadAssets(), retryDelay)
            }
            actions.setAssetsRefreshing(Boolean(data.cache?.refreshing))
            if (data.cache?.refreshing && data.assets.length === 0 && values.assets.length > 0) {
              return values.assets
            }
            return data.assets as AssetType[]
          } catch (error) {
            actions.setAssetsRefreshing(false)
            console.error(error)
            return values.assets
          }
        },
      },
    ],
    assetSync: [
      false,
      {
        syncAssets: async () => {
          // The on-device panel has no font store to sync from — it IS the
          // device. The backend and the cloud both do, and answer the same
          // path; the cloud streams its progress, which is handled below.
          const mode = workspaceMode()
          if (mode !== 'backend' && mode !== 'cloud') {
            return true
          }
          const taskId = `asset-sync:${props.frameId}:${Date.now()}`
          longRunningTasksModel.actions.startTask({
            id: taskId,
            frameId: props.frameId,
            kind: 'upload',
            title: 'Syncing fonts',
            detail: 'Preparing font sync',
          })
          try {
            const response = await apiFetch(frameAssetsApiPath(props.frameId, 'assets/sync'), {
              method: 'POST',
            })
            if (!response.ok) {
              throw new Error(await responseErrorMessage(response, 'Failed to sync fonts'))
            }
            // The cloud pushes one font per device round trip and reports each
            // as an NDJSON line, because the whole run takes minutes. The
            // backend copies over SSH and answers once, at the end.
            const summary = isFontSyncStream(response)
              ? await consumeFontSyncStream(response, (progress) => {
                  longRunningTasksModel.actions.updateTaskProgress({
                    taskId,
                    frameId: props.frameId,
                    kind: 'upload',
                    progressCurrent: progress.done,
                    progressTotal: progress.total,
                    detail: progress.detail,
                  })
                })
              : null
            if (summary && !summary.ok) {
              // Some fonts did land; saying "synced" would hide the rest.
              longRunningTasksModel.actions.taskFailed({
                taskId,
                frameId: props.frameId,
                kind: 'upload',
                detail: summary.detail,
              })
              actions.loadAssets()
              return false
            }
            longRunningTasksModel.actions.finishTask({
              taskId,
              frameId: props.frameId,
              kind: 'upload',
              detail: summary?.detail ?? 'Fonts synced',
            })
            actions.loadAssets()
            return true
          } catch (error) {
            console.error(error)
            longRunningTasksModel.actions.taskFailed({
              taskId,
              frameId: props.frameId,
              kind: 'upload',
              detail: errorMessage(error, 'Failed to sync fonts'),
            })
            return false
          }
        },
      },
    ],
  })),

  reducers({
    assetsRefreshing: [
      false,
      {
        setAssetsRefreshing: (_, { assetsRefreshing }) => assetsRefreshing,
      },
    ],
    // null until something reports it, and null forever for the frames that
    // never do — see storageMountedFromResponse.
    storageMounted: [
      null as boolean | null,
      {
        setStorageMounted: (_, { storageMounted }) => storageMounted,
      },
    ],
    showSystemFolders: [
      false,
      {
        toggleShowSystemFolders: (state) => !state,
      },
    ],
    // OS junk (.DS_Store, ._sidecars, Thumbs.db, @eaDir, …) is hidden by
    // default; the preference is global, not per frame — you plug the same
    // SD card into several frames.
    showHiddenFiles: [
      false,
      { persist: true, storageKey: 'assetsLogic.showHiddenFiles' },
      {
        toggleShowHiddenFiles: (state) => !state,
      },
    ],
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
      uploadProgress: (state, { path, size }) => {
        const foundAsset = state.find((asset) => asset.path === path)
        if (!foundAsset) {
          return [...state, { path, size, mtime: -1 }]
        }
        return state.map((asset) => (asset.path === path ? { ...asset, size, mtime: -1 } : asset))
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
      (s) => [s.cleanedAssets, s.frame, s.showSystemFolders, s.showHiddenFiles],
      (cleanedAssets, frame, showSystemFolders, showHiddenFiles) => {
        const visibleAssets = cleanedAssets.filter((asset) => {
          // The FrameOS-owned folders (.frameos, .thumbs) keep their own
          // toggle: they are ours, not the operating system's droppings.
          if (isSystemAssetPath(asset.path)) {
            return showSystemFolders
          }
          return showHiddenFiles || !isHiddenOrJunkAssetPath(asset.path)
        })
        return buildAssetTree(visibleAssets, frame.assets_path ?? '/srv/assets')
      },
    ],
    assetStats: [(s) => [s.assetTree], (assetTree) => collectAssetStats(assetTree)],
    storageUnmounted: [(s) => [s.storageMounted], (storageMounted): boolean => storageMounted === false],
    diskStats: [
      (s) => [s.sortedMetrics, s.cleanedAssets, s.frame],
      (sortedMetrics, cleanedAssets, frame): DiskStats | null => {
        // Virtual frames never emit disk metrics; show the backend asset
        // quota instead, with usage summed from the full listing (system
        // folders included — the quota counts them too).
        if (isVirtualFrame(frame)) {
          const usedBytes = cleanedAssets.reduce(
            (sum: number, asset: AssetType) => sum + (asset.is_dir ? 0 : asset.size || 0),
            0
          )
          const totalBytes = virtualQuotaBytes(frame)
          return {
            totalBytes,
            usedBytes,
            availableBytes: Math.max(0, totalBytes - usedBytes),
            usedPercent: totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0,
            isQuota: true,
          }
        }
        return latestDiskStats(sortedMetrics)
      },
    ],
  }),
  listeners(({ actions, props, values, cache }) => ({
    uploadDroppedFiles: async ({ path, files }) => {
      if (files.length === 0) {
        return
      }
      const assetsPath = values.frame.assets_path ?? '/srv/assets'
      const uploadedFiles = files.map((file) => normalizeAssetPath(`${path ? path + '/' : ''}${file.name}`, assetsPath))
      actions.filesToUpload(uploadedFiles)

      // One toast per frame: files dropped while an upload is running join
      // the running task (queue + growing totals) instead of replacing it.
      const queue: { file: File; path: string }[] = (cache.uploadQueue ??= [])
      for (const file of files) {
        queue.push({ file, path })
      }
      const batchBytes = files.reduce((total, file) => total + Math.max(file.size, 1), 0)

      const uploadTitle = (totalFiles: number): string =>
        totalFiles === 1 ? 'Uploading asset' : `Uploading ${totalFiles} assets`

      if (cache.uploadTask) {
        // A drain loop is already running: grow its totals and retitle.
        const task = cache.uploadTask
        task.totalFiles += files.length
        task.totalBytes += batchBytes
        longRunningTasksModel.actions.updateTaskProgress({
          taskId: task.id,
          frameId: props.frameId,
          kind: 'upload',
          title: uploadTitle(task.totalFiles),
          progressCurrent: task.lastReportedBytes,
          progressTotal: task.totalBytes,
        })
        return
      }

      const task = (cache.uploadTask = {
        id: `asset-upload:${props.frameId}:${Date.now()}:${files.length}`,
        totalFiles: files.length,
        totalBytes: batchBytes,
        completedBytes: 0,
        lastReportedBytes: 0,
        failures: 0,
        firstFileName: files[0].name,
      })

      longRunningTasksModel.actions.startTask({
        id: task.id,
        frameId: props.frameId,
        kind: 'upload',
        title: uploadTitle(task.totalFiles),
        detail: files.length === 1 ? files[0].name : 'Preparing upload',
        progressCurrent: 0,
        progressTotal: task.totalBytes,
      })

      try {
        while (queue.length > 0) {
          const { file, path: filePath } = queue.shift()!
          const uploadPath = frameAssetsApiPath(props.frameId, 'assets/upload')
          const normalizedPath = normalizeAssetPath(`${filePath ? filePath + '/' : ''}${file.name}`, assetsPath)
          const fileTaskBytes = Math.max(file.size, 1)
          const updateProgress = (fileUploadedBytes: number, detail = `Uploading ${file.name}`) => {
            const safeFileUploadedBytes = Math.max(0, Math.min(fileTaskBytes, fileUploadedBytes || 0))
            actions.uploadProgress(normalizedPath, Math.min(file.size, fileUploadedBytes || 0))
            task.lastReportedBytes = Math.min(task.totalBytes, task.completedBytes + safeFileUploadedBytes)
            longRunningTasksModel.actions.updateTaskProgress({
              taskId: task.id,
              frameId: props.frameId,
              kind: 'upload',
              progressCurrent: task.lastReportedBytes,
              progressTotal: task.totalBytes,
              detail,
            })
          }
          // Embedded frames always upload in chunks: the backend forwards each
          // chunk to the device synchronously, so one slow request never has to
          // carry the whole file and the progress bar tracks what the device
          // actually received. Retried chunks overwrite themselves (offset
          // semantics) — safe on the backend + ESP32, not on the Nim admin API.
          const chunkedUpload = isInFrameAdminMode() || values.frame.mode === 'embedded'
          try {
            const asset = chunkedUpload
              ? await uploadFileInChunks({
                  frameId: props.frameId,
                  suffix: 'assets/upload',
                  file,
                  path: filePath,
                  filename: file.name,
                  chunkSize: isInFrameAdminMode() ? undefined : 256 * 1024,
                  retries: isInFrameAdminMode() ? 0 : 2,
                  onProgress: (size) => updateProgress(size),
                })
              : await (async () => {
                  const formData = new FormData()
                  formData.append('file', file)
                  formData.append('path', filePath)
                  return await uploadFormDataWithProgress<AssetType>({
                    url: uploadPath,
                    formData,
                    onProgress: (uploadedBytes, totalBytes) => {
                      const fileUploadedBytes =
                        totalBytes && totalBytes > 0
                          ? Math.round((uploadedBytes / totalBytes) * fileTaskBytes)
                          : uploadedBytes
                      updateProgress(fileUploadedBytes)
                    },
                  })
                })()
            task.completedBytes += fileTaskBytes
            updateProgress(fileTaskBytes, `Uploaded ${file.name}`)
            actions.assetUploaded({
              ...asset,
              path: normalizeAssetPath(asset.path, assetsPath),
            })
          } catch (error) {
            task.failures += 1
            task.completedBytes += fileTaskBytes
            task.lastReportedBytes = Math.min(task.totalBytes, task.completedBytes)
            actions.uploadFailure(normalizedPath)
            longRunningTasksModel.actions.updateTaskProgress({
              taskId: task.id,
              frameId: props.frameId,
              kind: 'upload',
              progressCurrent: task.lastReportedBytes,
              progressTotal: task.totalBytes,
              detail: `Failed ${file.name}`,
            })
          }
        }
      } finally {
        cache.uploadTask = null
      }

      if (task.failures > 0) {
        longRunningTasksModel.actions.taskFailed({
          taskId: task.id,
          frameId: props.frameId,
          kind: 'upload',
          detail: task.failures === 1 ? '1 asset failed to upload' : `${task.failures} assets failed to upload`,
        })
      } else {
        longRunningTasksModel.actions.finishTask({
          taskId: task.id,
          frameId: props.frameId,
          kind: 'upload',
          detail: task.totalFiles === 1 ? `Uploaded ${task.firstFileName}` : `Uploaded ${task.totalFiles} assets`,
        })
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
  afterMount(({ actions }) => {
    actions.loadAssets()
  }),
  beforeUnmount(({ cache }) => {
    window.clearTimeout(cache.reloadTimer)
  }),
])
