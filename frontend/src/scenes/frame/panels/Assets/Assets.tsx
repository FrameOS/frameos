import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { frameLogic } from '../../frameLogic'
import { assetsLogic } from './assetsLogic'
import { panelsLogic } from '../panelsLogic'
import { DocumentIcon, FolderIcon, FolderOpenIcon } from '@heroicons/react/24/outline'
import {
  CloudArrowDownIcon,
  DocumentArrowUpIcon,
  PlayIcon,
  PencilSquareIcon,
  TrashIcon,
  FolderPlusIcon,
} from '@heroicons/react/24/solid'
import { useEffect, useState, type DragEvent } from 'react'
import { apiFetch } from '../../../../utils/apiFetch'
import { Spinner } from '../../../../components/Spinner'
import { DropdownMenu, DropdownMenuItem } from '../../../../components/DropdownMenu'
import { DeferredImage } from '../../../../components/DeferredImage'
import { buildLocalImageFolderScene, buildLocalImageScene } from '../Scenes/sceneShortcuts'
import { v4 as uuidv4 } from 'uuid'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { frameAssetUrl } from '../../../../utils/frameAssetsApi'
import { metricsLogic } from '../Metrics/metricsLogic'
import type { MetricsType } from '../../../../types'

function humaniseSize(size: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  while (size > 1024 && unitIndex < units.length) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`
}

const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '*.qoi', '.ppm', '.svg']
const normalizedImageExtensions = imageExtensions.map((extension) => extension.replace('*', '').toLowerCase())
const hasImageExtension = (fileName: string): boolean => {
  const normalizedName = fileName.toLowerCase()
  return normalizedImageExtensions.some((extension) => normalizedName.endsWith(extension))
}
const playSceneButtonClassName =
  'frameos-primary-text shrink-0 rounded-full border border-[#4a4b8c]/35 bg-[#4a4b8c]/10 p-1.5 transition hover:bg-[#4a4b8c]/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'

interface AssetStats {
  files: number
  folders: number
  images: number
  totalBytes: number
  latestMtime: number | null
}

interface DiskStats {
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usedPercent: number
}

// Define the shape of the node we get back from buildAssetTree
interface AssetNode {
  name: string
  path: string
  isFolder: boolean
  size?: number
  mtime?: number
  children: Record<string, AssetNode>
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
    stats.images =
      hasImageExtension(node.name) && !node.path.startsWith('.thumbs/') && !node.path.includes('/.thumbs/') ? 1 : 0
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

function formatDateFromSeconds(timestamp: number | null): string {
  if (!timestamp) {
    return 'Never'
  }
  return new Date(timestamp * 1000).toLocaleString()
}

/** A recursive component that renders a folder or a file */
function TreeNode({
  node,
  frameId,
  openAsset,
  uploadAssets,
  deleteAsset,
  renameAsset,
  createFolder,
  createImageScene,
  createImageFolderScene,
  uploadDroppedFiles,
}: {
  node: AssetNode
  frameId: number
  openAsset: (path: string) => void
  uploadAssets: (path: string) => void
  deleteAsset: (path: string) => void
  renameAsset: (oldPath: string, newPath: string) => void
  createFolder: (path: string) => void
  createImageScene: (path: string) => void
  createImageFolderScene: (path: string) => void
  uploadDroppedFiles: (path: string, files: File[]) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(node.path === '')
  const [isDownloading, setIsDownloading] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  const uploadPath = node.isFolder ? node.path : node.path.split('/').slice(0, -1).join('/')

  const onDropFiles = (event: DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragOver(false)
    const files = Array.from(event.dataTransfer.files || [])
    if (!files.length) {
      return
    }
    uploadDroppedFiles(uploadPath, files)
  }

  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    setIsDragOver(true)
  }

  const onDragLeave = (event: DragEvent): void => {
    event.stopPropagation()
    setIsDragOver(false)
  }

  // If this node is a folder, display a collapsible section
  if (node.isFolder) {
    return (
      <div className="ml-1">
        <div
          className={clsx(
            'frame-tool-row mb-1 flex items-center gap-2 rounded-xl px-3 py-2 transition',
            isDragOver && 'border-[#4a4b8c] bg-[#4a4b8c]/10'
          )}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDropFiles}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <FolderOpenIcon className="h-5 w-5 shrink-0 text-blue-400" />
            ) : (
              <FolderIcon className="h-5 w-5 shrink-0 text-blue-400" />
            )}
            <span className="truncate font-medium">{node.name || '/'}</span>
            <span className="frame-tool-muted shrink-0 text-xs">{Object.keys(node.children).length} items</span>
          </button>
          <button
            type="button"
            className={playSceneButtonClassName}
            title="Play all images in this folder"
            onClick={() => createImageFolderScene(node.path)}
          >
            <PlayIcon className="h-4 w-4" />
          </button>
          <DropdownMenu
            horizontal
            className="w-fit"
            buttonColor="none"
            items={
              [
                {
                  label: 'Upload files',
                  icon: <DocumentArrowUpIcon className="w-5 h-5" />,
                  onClick: () => uploadAssets(node.path),
                },
                {
                  label: 'New folder',
                  icon: <FolderPlusIcon className="w-5 h-5" />,
                  onClick: () => {
                    const name = window.prompt('Folder name')
                    if (name) {
                      const newPath = (node.path ? node.path + '/' : '') + name
                      createFolder(newPath)
                    }
                  },
                },
                {
                  label: 'Play all images in this folder',
                  icon: <PlayIcon className="w-5 h-5" />,
                  onClick: () => createImageFolderScene(node.path),
                },
                node.path
                  ? {
                      label: 'Rename',
                      icon: <PencilSquareIcon className="w-5 h-5" />,
                      onClick: () => {
                        const base = node.path.split('/').slice(0, -1).join('/')
                        const newName = window.prompt('New name', node.name)
                        if (newName) {
                          const newPath = (base ? base + '/' : '') + newName
                          renameAsset(node.path, newPath)
                        }
                      },
                    }
                  : null,
                node.path
                  ? {
                      label: 'Delete',
                      confirm: 'Are you sure?',
                      icon: <TrashIcon className="w-5 h-5" />,
                      onClick: () => deleteAsset(node.path),
                    }
                  : null,
              ].filter(Boolean) as DropdownMenuItem[]
            }
          />
        </div>
        {expanded && (
          <div
            className={clsx('ml-4 border-l pl-3', isDragOver ? 'border-[#4a4b8c]' : 'border-slate-300/70')}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDropFiles}
          >
            {Object.values(node.children).map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                frameId={frameId}
                openAsset={openAsset}
                uploadAssets={uploadAssets}
                deleteAsset={deleteAsset}
                renameAsset={renameAsset}
                createFolder={createFolder}
                createImageScene={createImageScene}
                createImageFolderScene={createImageFolderScene}
                uploadDroppedFiles={uploadDroppedFiles}
              />
            ))}
          </div>
        )}
      </div>
    )
  } else {
    // This is a file
    const isImage = node.name.match(/\.(png|jpe?g|gif|bmp|webp)$/i)
    const isPlayableImage =
      hasImageExtension(node.name) && !node.path.startsWith('.thumbs/') && !node.path.includes('/.thumbs/')
    const isUploading = node.mtime === -1
    return (
      <div
        className={clsx(
          'frame-tool-row mb-1 ml-1 flex items-center gap-3 rounded-xl px-3 py-2 transition',
          isDragOver && 'border-[#4a4b8c] bg-[#4a4b8c]/10'
        )}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDropFiles}
      >
        {isImage &&
          node.size !== undefined &&
          node.mtime !== undefined &&
          node.size >= 0 &&
          node.mtime >= 0 &&
          !node.path.startsWith('.thumbs/') &&
          !node.path.includes('/.thumbs/') && (
            <div className="w-8 h-8">
              <DeferredImage
                url={frameAssetUrl(frameId, node.path, true)}
                className="w-8 h-8 object-cover border border-gray-600 rounded"
                spinnerClassName="w-4 h-4"
              />
            </div>
          )}
        {!isImage ? <DocumentIcon className="h-5 w-5 shrink-0 frame-tool-muted" /> : null}
        <div className="flex-1">
          <span className="cursor-pointer font-medium hover:underline" onClick={() => openAsset(node.path)}>
            {node.name}
          </span>
        </div>
        {isPlayableImage ? (
          <button
            type="button"
            className={playSceneButtonClassName}
            title="Run image scene"
            onClick={() => createImageScene(node.path)}
          >
            <PlayIcon className="w-4 h-4" />
          </button>
        ) : null}
        {typeof node.size === 'number' && node.size >= 0 && (node.size > 0 || isUploading) ? (
          <span className="frame-tool-muted text-xs">{humaniseSize(node.size)}</span>
        ) : null}
        {node.mtime && node.mtime > 0 && (
          <span
            className="frame-tool-muted hidden text-xs md:inline"
            title={new Date(node.mtime * 1000).toLocaleString()}
          >
            {new Date(node.mtime * 1000).toLocaleString()}
          </span>
        )}
        {isUploading || isDownloading ? (
          <Spinner className="w-4 h-4" color="white" />
        ) : node.size === -2 && node.mtime === -2 ? (
          <span className="text-red-500">Upload error</span>
        ) : null}
        <DropdownMenu
          horizontal
          className="w-fit"
          buttonColor="none"
          items={[
            {
              label: 'Download',
              icon: isDownloading ? (
                <Spinner className="w-4 h-4 inline-block" />
              ) : (
                <CloudArrowDownIcon className="w-4 h-4 inline-block" />
              ),
              onClick: async () => {
                setIsDownloading(true)
                const resource = await apiFetch(frameAssetUrl(frameId, node.path))
                if (!resource.ok) {
                  setIsDownloading(false)
                  throw new Error('Failed to download asset')
                }
                const blob = await resource.blob()
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = node.name
                a.click()
                URL.revokeObjectURL(url)
                setIsDownloading(false)
              },
            },
            {
              label: 'Rename',
              icon: <PencilSquareIcon className="w-4 h-4" />,
              onClick: () => {
                const base = node.path.split('/').slice(0, -1).join('/')
                const newName = window.prompt('New name', node.name)
                if (newName) {
                  const newPath = (base ? base + '/' : '') + newName
                  renameAsset(node.path, newPath)
                }
              },
            },
            {
              label: 'Delete',
              confirm: 'Are you sure?',
              icon: <TrashIcon className="w-4 h-4" />,
              onClick: () => deleteAsset(node.path),
            },
          ]}
        />
      </div>
    )
  }
}

function AssetsLoadingSkeleton(): JSX.Element {
  const rows = [
    { indent: 'pl-0', icon: 'rounded-md', name: 'w-36', detail: 'w-14' },
    { indent: 'pl-6', icon: 'rounded', name: 'w-48', detail: 'w-20' },
    { indent: 'pl-6', icon: 'rounded', name: 'w-40', detail: 'w-16' },
    { indent: 'pl-0', icon: 'rounded-md', name: 'w-32', detail: 'w-12' },
    { indent: 'pl-6', icon: 'rounded', name: 'w-52', detail: 'w-20' },
    { indent: 'pl-12', icon: 'rounded', name: 'w-44', detail: 'w-16' },
    { indent: 'pl-12', icon: 'rounded', name: 'w-28', detail: 'w-14' },
  ]

  return (
    <div className="space-y-4">
      <div className="frameos-skeleton-surface frameos-divider rounded-[22px] border border-slate-200/70 p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="frameos-skeleton-media h-10 w-10 animate-pulse rounded-2xl" />
            <div className="min-w-0 space-y-2">
              <div className="frameos-skeleton-line h-4 w-36 max-w-full animate-pulse rounded-full" />
              <div className="frameos-skeleton-line h-3 w-56 max-w-full animate-pulse rounded-full opacity-70" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="frameos-skeleton-line h-9 w-24 animate-pulse rounded-full opacity-80" />
            <div className="frameos-skeleton-media h-9 w-9 animate-pulse rounded-full" />
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="frameos-skeleton-surface frameos-divider rounded-[22px] border border-slate-200/70 p-3 shadow-sm">
          <div className="mb-3 flex items-center gap-2 px-2">
            <div className="frameos-skeleton-line h-3 w-24 animate-pulse rounded-full" />
            <div className="frameos-skeleton-line h-3 w-14 animate-pulse rounded-full opacity-60" />
          </div>
          <div className="space-y-1">
            {rows.map((row, index) => (
              <div key={index} className={clsx('flex items-center gap-3 rounded-xl px-3 py-2', row.indent)}>
                <div className={clsx('frameos-skeleton-media h-5 w-5 shrink-0 animate-pulse', row.icon)} />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className={clsx('frameos-skeleton-line h-3 max-w-full animate-pulse rounded-full', row.name)} />
                  {index % 3 === 1 ? (
                    <div className="frameos-skeleton-line h-2 w-24 max-w-full animate-pulse rounded-full opacity-60" />
                  ) : null}
                </div>
                <div className={clsx('frameos-skeleton-line h-3 shrink-0 animate-pulse rounded-full', row.detail)} />
                <div className="frameos-skeleton-media h-8 w-8 shrink-0 animate-pulse rounded-full" />
              </div>
            ))}
          </div>
        </div>

        <div className="frameos-skeleton-surface frameos-divider hidden rounded-[22px] border border-slate-200/70 p-4 shadow-sm xl:block">
          <div className="frameos-skeleton-line mb-4 h-3 w-28 animate-pulse rounded-full" />
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="space-y-2">
                <div className="frameos-skeleton-media aspect-square animate-pulse rounded-2xl" />
                <div className="frameos-skeleton-line h-2.5 animate-pulse rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function AssetsSummaryHeader({
  rootName,
  stats,
  diskStats,
  showSyncAction,
  onSync,
}: {
  rootName: string
  stats: AssetStats
  diskStats: DiskStats | null
  showSyncAction: boolean
  onSync: () => void
}): JSX.Element {
  const diskUsedPercent = diskStats ? Math.min(Math.max(diskStats.usedPercent, 0), 100) : null
  const statItems = [
    {
      label: 'Files',
      value: String(stats.files),
      detail: `${stats.folders} folder${stats.folders === 1 ? '' : 's'}`,
    },
    { label: 'Images', value: String(stats.images), detail: `${humaniseSize(stats.totalBytes)} assets` },
    { label: 'Updated', value: formatDateFromSeconds(stats.latestMtime), detail: rootName || '/srv/assets' },
  ]

  return (
    <div className="frame-tool-card mb-4 overflow-hidden rounded-[22px]">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
        <div className="min-w-0">
          <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Assets</div>
          <div className="mt-1 truncate text-xl font-bold tracking-normal text-[color:var(--tool-strong)]">
            {rootName || '/srv/assets'}
          </div>
        </div>
        {showSyncAction ? (
          <DropdownMenu
            className="w-fit"
            buttonColor="secondary"
            items={[
              {
                label: 'Sync fonts',
                onClick: onSync,
                icon: <DocumentArrowUpIcon className="w-5 h-5" />,
              },
            ]}
          />
        ) : null}
      </div>
      <div className="grid gap-px border-t border-[color:var(--tool-border)] bg-[var(--tool-border)] md:grid-cols-4">
        {statItems.map((item) => (
          <div key={item.label} className="bg-[var(--tool-bg)] px-4 py-3">
            <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{item.label}</div>
            <div className="mt-1 truncate text-lg font-semibold text-[color:var(--tool-strong)]">{item.value}</div>
            <div className="frame-tool-muted mt-0.5 truncate text-xs">{item.detail}</div>
          </div>
        ))}
        <div className="bg-[var(--tool-bg)] px-4 py-3">
          <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Disk</div>
          {diskStats ? (
            <>
              <div className="mt-1 text-lg font-semibold text-[color:var(--tool-strong)]">
                {Math.round(diskUsedPercent ?? 0)}% used
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-400/20">
                <div className="h-full rounded-full bg-[#4a4b8c]" style={{ width: `${diskUsedPercent ?? 0}%` }} />
              </div>
              <div className="frame-tool-muted mt-1 truncate text-xs">
                {humaniseSize(diskStats.availableBytes)} free / {humaniseSize(diskStats.totalBytes)}
              </div>
            </>
          ) : (
            <>
              <div className="mt-1 text-lg font-semibold text-[color:var(--tool-strong)]">No sample</div>
              <div className="frame-tool-muted mt-0.5 text-xs">Waiting for metrics</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface AssetsProps {
  scrollContainer?: boolean
}

export function Assets({ scrollContainer = true }: AssetsProps = {}): JSX.Element {
  const { frame, frameForm } = useValues(frameLogic)
  const { sendEvent } = useActions(frameLogic)
  const { openLogs } = useActions(panelsLogic)
  const { assetsLoading, assetTree } = useValues(assetsLogic({ frameId: frame.id }))
  const { sortedMetrics } = useValues(metricsLogic({ frameId: frame.id }))
  const { loadAssets, syncAssets, uploadAssets, uploadDroppedFiles, deleteAsset, renameAsset, createFolder } =
    useActions(assetsLogic({ frameId: frame.id }))
  const { openAsset } = useActions(panelsLogic({ frameId: frame.id }))
  const assetStats = collectAssetStats(assetTree)
  const diskStats = latestDiskStats(sortedMetrics)
  const showSyncAction = !isInFrameAdminMode()

  const handleSyncAssets = () => {
    syncAssets()
    openLogs()
  }

  const createImageScene = async (path: string): Promise<void> => {
    const assetsPath = frameForm.assets_path || frame.assets_path || '/srv/assets'
    const normalizedPath = path.replace(/^\.\//, '')
    const parts = normalizedPath.split('/').filter(Boolean)
    const filename = parts.pop() || normalizedPath
    const folderPath = parts.join('/')
    const imageFolder = folderPath ? `${assetsPath}/${folderPath}` : assetsPath
    const sceneId = uuidv4()
    const scene = buildLocalImageScene(filename, imageFolder, sceneId)
    try {
      await sendEvent('uploadScenes', { scenes: [scene], sceneId })
    } catch (error) {
      console.error(error)
      alert('Failed to create image scene')
    }
  }

  const createImageFolderScene = async (path: string): Promise<void> => {
    const assetsPath = frameForm.assets_path || frame.assets_path || '/srv/assets'
    const normalizedPath = path.replace(/^\.\//, '')
    const parts = normalizedPath.split('/').filter(Boolean)
    const folderPath = parts.join('/')
    const imageFolder = folderPath ? `${assetsPath}/${folderPath}` : assetsPath
    const sceneId = uuidv4()
    const scene = buildLocalImageFolderScene(imageFolder, sceneId)
    try {
      await sendEvent('uploadScenes', { scenes: [scene], sceneId })
    } catch (error) {
      console.error(error)
      alert('Failed to create image scene')
    }
  }

  useEffect(() => {
    loadAssets()
  }, [])

  return (
    <div className={clsx('frame-tool-panel', scrollContainer ? 'h-full overflow-y-auto pr-2' : 'overflow-visible')}>
      {assetsLoading && (!assetTree.children || Object.keys(assetTree.children).length === 0) ? (
        <AssetsLoadingSkeleton />
      ) : (
        <div className="space-y-1">
          <AssetsSummaryHeader
            rootName={assetTree.name}
            stats={assetStats}
            diskStats={diskStats}
            showSyncAction={showSyncAction}
            onSync={handleSyncAssets}
          />
          <TreeNode
            node={assetTree}
            frameId={frame.id}
            openAsset={openAsset}
            uploadAssets={uploadAssets}
            deleteAsset={deleteAsset}
            renameAsset={renameAsset}
            createFolder={createFolder}
            createImageScene={createImageScene}
            createImageFolderScene={createImageFolderScene}
            uploadDroppedFiles={uploadDroppedFiles}
          />
        </div>
      )}
    </div>
  )
}
