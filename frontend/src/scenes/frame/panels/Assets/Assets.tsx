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

// Define the shape of the node we get back from buildAssetTree
interface AssetNode {
  name: string
  path: string
  isFolder: boolean
  size?: number
  mtime?: number
  children: Record<string, AssetNode>
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
            className="rounded-full border border-purple-500/40 bg-purple-500/10 p-1 text-purple-300 hover:bg-purple-500/20 hover:text-purple-200"
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

interface AssetsProps {
  scrollContainer?: boolean
}

export function Assets({ scrollContainer = true }: AssetsProps = {}): JSX.Element {
  const { frame, frameForm } = useValues(frameLogic)
  const { sendEvent } = useActions(frameLogic)
  const { openLogs } = useActions(panelsLogic)
  const { assetsLoading, assetTree } = useValues(assetsLogic({ frameId: frame.id }))
  const { loadAssets, syncAssets, uploadAssets, uploadDroppedFiles, deleteAsset, renameAsset, createFolder } =
    useActions(assetsLogic({ frameId: frame.id }))
  const { openAsset } = useActions(panelsLogic({ frameId: frame.id }))

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
      {!isInFrameAdminMode() ? (
        <div className="mb-3 flex justify-end">
          <DropdownMenu
            className="w-fit"
            buttonColor="secondary"
            items={[
              {
                label: 'Sync fonts',
                onClick: () => {
                  syncAssets()
                  openLogs()
                },
                icon: <DocumentArrowUpIcon className="w-5 h-5" />,
              },
            ]}
          />
        </div>
      ) : null}
      {assetsLoading && (!assetTree.children || Object.keys(assetTree.children).length === 0) ? (
        <div className="frame-tool-card flex h-44 items-center justify-center gap-2 rounded-[22px] text-sm frame-tool-muted">
          <Spinner />
          Loading assets...
        </div>
      ) : (
        <div className="space-y-1">
          {assetsLoading ? (
            <div className="mb-2 flex justify-end">
              <Spinner />
            </div>
          ) : null}
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
