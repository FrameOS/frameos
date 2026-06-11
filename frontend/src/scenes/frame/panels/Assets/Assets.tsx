import { useActions, useMountedLogic, useValues } from 'kea'
import clsx from 'clsx'
import { frameLogic } from '../../frameLogic'
import {
  assetsLogic,
  isInThumbsFolder,
  nodeHasPlayableImages,
  type AssetNode,
  type AssetStats,
  type DiskStats,
} from './assetsLogic'
import { DocumentIcon, EyeIcon, EyeSlashIcon, FolderIcon, FolderOpenIcon } from '@heroicons/react/24/outline'
import {
  CloudArrowDownIcon,
  DocumentArrowUpIcon,
  ArrowPathIcon,
  PlayIcon,
  PencilSquareIcon,
  TrashIcon,
  FolderPlusIcon,
} from '@heroicons/react/24/solid'
import { useState, type DragEvent } from 'react'
import { Spinner } from '../../../../components/Spinner'
import { DropdownMenu, DropdownMenuItem } from '../../../../components/DropdownMenu'
import { DeferredImage } from '../../../../components/DeferredImage'
import { buildLocalImageFolderScene, buildLocalImageScene } from '../Scenes/sceneShortcuts'
import { v4 as uuidv4 } from 'uuid'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { frameAssetUrl } from '../../../../utils/frameAssetsApi'
import { frameAssetFolderExpansionKey, workspaceLogic } from '../../../workspace/workspaceLogic'

function humaniseSize(size: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  while (size > 1024 && unitIndex < units.length) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`
}

const playSceneButtonClassName =
  'asset-play-button frameos-primary-outline-action shrink-0 rounded-lg border p-1.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'
const assetRowActionsClassName = 'asset-row-actions ml-auto flex w-[5.25rem] shrink-0 items-center justify-end gap-2'
const thumbnailImagePattern = /\.(png|jpe?g|gif|bmp|webp)$/i
const browserImagePattern = /\.(png|jpe?g|gif|bmp|webp|svg)$/i

function formatDateFromSeconds(timestamp: number | null): string {
  if (!timestamp) {
    return 'Never'
  }
  return new Date(timestamp * 1000).toLocaleString()
}

function hasAssetThumbnail(name: string): boolean {
  return thumbnailImagePattern.test(name)
}

function opensAsBrowserImage(name: string): boolean {
  return browserImagePattern.test(name)
}

function openFrameAsset(frameId: number, path: string, name: string): void {
  const openInline = opensAsBrowserImage(name)
  const url = frameAssetUrl(frameId, path, {
    filename: name,
    mode: openInline ? 'image' : 'download',
  })

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  if (!openInline) {
    anchor.download = name
  }
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** A recursive component that renders a folder or a file */
function TreeNode({
  node,
  frameId,
  uploadAssets,
  deleteAsset,
  renameAsset,
  createFolder,
  createImageScene,
  createImageFolderScene,
  uploadDroppedFiles,
  frameAssetFolderExpansion,
  setFrameAssetFolderExpanded,
  showSystemFolders,
  toggleShowSystemFolders,
}: {
  node: AssetNode
  frameId: number
  uploadAssets: (path: string) => void
  deleteAsset: (path: string) => void
  renameAsset: (oldPath: string, newPath: string) => void
  createFolder: (path: string) => void
  createImageScene: (path: string) => void
  createImageFolderScene: (path: string) => void
  uploadDroppedFiles: (path: string, files: File[]) => void
  frameAssetFolderExpansion: Record<string, boolean>
  setFrameAssetFolderExpanded: (frameId: number, path: string, expanded: boolean) => void
  showSystemFolders: boolean
  toggleShowSystemFolders: () => void
}): JSX.Element {
  const expansionKey = frameAssetFolderExpansionKey(frameId, node.path)
  const expanded = frameAssetFolderExpansion[expansionKey] ?? node.path === ''
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
    const hasPlayableImages = nodeHasPlayableImages(node)

    return (
      <div className="ml-1">
        <div
          className={clsx(
            'asset-tree-row frame-tool-row mb-1 flex items-center gap-2 rounded-xl px-3 py-2 transition',
            isDragOver && 'frameos-primary-drop-target'
          )}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDropFiles}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => setFrameAssetFolderExpanded(frameId, node.path, !expanded)}
          >
            {expanded ? (
              <FolderOpenIcon className="asset-row-icon frameos-folder-icon h-5 w-5 shrink-0" />
            ) : (
              <FolderIcon className="asset-row-icon frameos-folder-icon h-5 w-5 shrink-0" />
            )}
            <span className="truncate font-medium">{node.name || '/'}</span>
            <span className="asset-folder-count frame-tool-muted shrink-0 text-xs">
              {Object.keys(node.children).length} items
            </span>
          </button>
          <div className={assetRowActionsClassName}>
            {hasPlayableImages ? (
              <button
                type="button"
                className={playSceneButtonClassName}
                title="Play all images in this folder"
                onClick={() => createImageFolderScene(node.path)}
              >
                <PlayIcon className="h-4 w-4" />
              </button>
            ) : null}
            <DropdownMenu
              horizontal
              className="w-fit"
              buttonColor="tertiary"
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
                  hasPlayableImages
                    ? {
                        label: 'Play all images in this folder',
                        icon: <PlayIcon className="w-5 h-5" />,
                        onClick: () => createImageFolderScene(node.path),
                      }
                    : null,
                  !node.path
                    ? {
                        label: showSystemFolders ? 'Hide system folders' : 'Show system folders',
                        icon: showSystemFolders ? (
                          <EyeSlashIcon className="w-5 h-5" />
                        ) : (
                          <EyeIcon className="w-5 h-5" />
                        ),
                        onClick: toggleShowSystemFolders,
                      }
                    : null,
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
        </div>
        {expanded && (
          <div
            className={clsx(
              'asset-tree-children ml-4 border-l pl-3',
              isDragOver ? 'frameos-primary-border' : 'border-slate-300/70'
            )}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDropFiles}
          >
            {Object.values(node.children).map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                frameId={frameId}
                uploadAssets={uploadAssets}
                deleteAsset={deleteAsset}
                renameAsset={renameAsset}
                createFolder={createFolder}
                createImageScene={createImageScene}
                createImageFolderScene={createImageFolderScene}
                uploadDroppedFiles={uploadDroppedFiles}
                frameAssetFolderExpansion={frameAssetFolderExpansion}
                setFrameAssetFolderExpanded={setFrameAssetFolderExpanded}
                showSystemFolders={showSystemFolders}
                toggleShowSystemFolders={toggleShowSystemFolders}
              />
            ))}
          </div>
        )}
      </div>
    )
  } else {
    // This is a file
    const hasThumbnail = hasAssetThumbnail(node.name)
    const opensInline = opensAsBrowserImage(node.name)
    const isPlayableImage = nodeHasPlayableImages(node)
    const isUploading = node.mtime === -1
    return (
      <div
        className={clsx(
          'asset-tree-row frame-tool-row mb-1 ml-1 flex items-center gap-3 rounded-xl px-3 py-2 transition',
          isDragOver && 'frameos-primary-drop-target'
        )}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDropFiles}
      >
        {hasThumbnail &&
          node.size !== undefined &&
          node.mtime !== undefined &&
          node.size >= 0 &&
          node.mtime >= 0 &&
          !isInThumbsFolder(node.path) && (
            <div className="asset-file-thumb w-8 h-8">
              <DeferredImage
                url={frameAssetUrl(frameId, node.path, true)}
                className="frameos-card-media w-8 h-8 object-cover border rounded"
                spinnerClassName="w-4 h-4"
              />
            </div>
          )}
        {!hasThumbnail ? <DocumentIcon className="asset-row-icon h-5 w-5 shrink-0 frame-tool-muted" /> : null}
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block max-w-full truncate text-left font-medium hover:underline"
            onClick={() => openFrameAsset(frameId, node.path, node.name)}
          >
            {node.name}
          </button>
        </div>
        {typeof node.size === 'number' && node.size >= 0 && (node.size > 0 || isUploading) ? (
          <span className="asset-file-size frame-tool-muted shrink-0 text-xs">{humaniseSize(node.size)}</span>
        ) : null}
        {node.mtime && node.mtime > 0 && (
          <span
            className="frame-tool-muted hidden shrink-0 text-xs @md:inline"
            title={new Date(node.mtime * 1000).toLocaleString()}
          >
            {new Date(node.mtime * 1000).toLocaleString()}
          </span>
        )}
        {isUploading ? (
          <Spinner className="w-4 h-4" color="white" />
        ) : node.size === -2 && node.mtime === -2 ? (
          <span className="text-red-500">Upload error</span>
        ) : null}
        <div className={assetRowActionsClassName}>
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
          <DropdownMenu
            horizontal
            className="w-fit"
            buttonColor="tertiary"
            items={
              [
                isPlayableImage
                  ? {
                      label: 'Run image scene',
                      icon: <PlayIcon className="w-4 h-4" />,
                      onClick: () => createImageScene(node.path),
                    }
                  : null,
                {
                  label: opensInline ? 'Open image' : 'Download',
                  icon: <CloudArrowDownIcon className="w-4 h-4 inline-block" />,
                  onClick: () => openFrameAsset(frameId, node.path, node.name),
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
              ].filter(Boolean) as DropdownMenuItem[]
            }
          />
        </div>
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

      <div className="grid gap-4 @5xl:grid-cols-[minmax(0,1fr)_18rem]">
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

        <div className="frameos-skeleton-surface frameos-divider hidden rounded-[22px] border border-slate-200/70 p-4 shadow-sm @5xl:block">
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
  isReloading,
  onRefresh,
  onSync,
}: {
  rootName: string
  stats: AssetStats
  diskStats: DiskStats | null
  showSyncAction: boolean
  isReloading: boolean
  onRefresh: () => void
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
      <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-3 @3xl:gap-3 @3xl:px-4 @3xl:py-4">
        <div className="min-w-0">
          <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Assets</div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <div className="truncate text-lg font-bold tracking-normal text-[color:var(--tool-strong)] @3xl:text-xl">
              {rootName || '/srv/assets'}
            </div>
            {isReloading ? <Spinner className="h-4 w-4 shrink-0" /> : null}
          </div>
        </div>
        <DropdownMenu
          className="w-fit"
          buttonColor="tertiary"
          items={
            [
              {
                label: isReloading ? 'Refreshing' : 'Refresh',
                onClick: onRefresh,
                icon: <ArrowPathIcon className="w-5 h-5" />,
                loading: isReloading,
              },
              showSyncAction
                ? {
                    label: 'Sync fonts',
                    onClick: onSync,
                    icon: <DocumentArrowUpIcon className="w-5 h-5" />,
                  }
                : null,
            ].filter(Boolean) as DropdownMenuItem[]
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-[color:var(--tool-border)] bg-[var(--tool-border)] @3xl:grid-cols-4">
        {statItems.map((item) => (
          <div key={item.label} className="bg-[var(--tool-bg)] px-3 py-2 @3xl:px-4 @3xl:py-3">
            <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{item.label}</div>
            <div className="mt-0.5 truncate text-base font-semibold text-[color:var(--tool-strong)] @3xl:mt-1 @3xl:text-lg">
              {item.value}
            </div>
            <div className="frame-tool-muted mt-0.5 truncate text-xs">{item.detail}</div>
          </div>
        ))}
        <div className="bg-[var(--tool-bg)] px-3 py-2 @3xl:px-4 @3xl:py-3">
          <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Disk</div>
          {diskStats ? (
            <>
              <div className="mt-0.5 text-base font-semibold text-[color:var(--tool-strong)] @3xl:mt-1 @3xl:text-lg">
                {Math.round(diskUsedPercent ?? 0)}% used
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-400/20 @3xl:mt-2">
                <div
                  className="frameos-primary-fill h-full rounded-full"
                  style={{ width: `${diskUsedPercent ?? 0}%` }}
                />
              </div>
              <div className="frame-tool-muted mt-1 truncate text-xs">
                {humaniseSize(diskStats.availableBytes)} free / {humaniseSize(diskStats.totalBytes)}
              </div>
            </>
          ) : (
            <>
              <div className="mt-0.5 text-base font-semibold text-[color:var(--tool-strong)] @3xl:mt-1 @3xl:text-lg">
                No sample
              </div>
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
  const assetsLogicProps = { frameId: frame.id }
  useMountedLogic(assetsLogic(assetsLogicProps))
  const { sendEvent } = useActions(frameLogic)
  const { assetsLoading, assetsRefreshing, assetStats, assetTree, diskStats, showSystemFolders } = useValues(
    assetsLogic(assetsLogicProps)
  )
  const { frameAssetFolderExpansion } = useValues(workspaceLogic)
  const { refreshAssets, syncAssets, uploadAssets, uploadDroppedFiles, deleteAsset, renameAsset, createFolder } =
    useActions(assetsLogic(assetsLogicProps))
  const { toggleShowSystemFolders } = useActions(assetsLogic(assetsLogicProps))
  const { setFrameAssetFolderExpanded } = useActions(workspaceLogic)
  const showSyncAction = !isInFrameAdminMode()

  // syncAssets registers a long-running task toast, so no need to open logs
  const handleSyncAssets = () => {
    syncAssets()
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

  return (
    <div
      className={clsx(
        'assets-panel frame-tool-panel @container',
        scrollContainer ? 'h-full overflow-y-auto pr-2' : 'overflow-visible'
      )}
    >
      {assetsLoading && (!assetTree.children || Object.keys(assetTree.children).length === 0) ? (
        <AssetsLoadingSkeleton />
      ) : (
        <div className="space-y-1">
          <AssetsSummaryHeader
            rootName={assetTree.name}
            stats={assetStats}
            diskStats={diskStats}
            showSyncAction={showSyncAction}
            isReloading={assetsLoading || assetsRefreshing}
            onRefresh={refreshAssets}
            onSync={handleSyncAssets}
          />
          <TreeNode
            node={assetTree}
            frameId={frame.id}
            uploadAssets={uploadAssets}
            deleteAsset={deleteAsset}
            renameAsset={renameAsset}
            createFolder={createFolder}
            createImageScene={createImageScene}
            createImageFolderScene={createImageFolderScene}
            uploadDroppedFiles={uploadDroppedFiles}
            frameAssetFolderExpansion={frameAssetFolderExpansion}
            setFrameAssetFolderExpanded={setFrameAssetFolderExpanded}
            showSystemFolders={showSystemFolders}
            toggleShowSystemFolders={toggleShowSystemFolders}
          />
        </div>
      )}
    </div>
  )
}
