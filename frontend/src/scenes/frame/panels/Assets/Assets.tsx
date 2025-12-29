import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { assetsLogic } from './assetsLogic'
import { panelsLogic } from '../panelsLogic'
import {
  CloudArrowDownIcon,
  DocumentArrowUpIcon,
  PlayIcon,
  PencilSquareIcon,
  TrashIcon,
  FolderPlusIcon,
} from '@heroicons/react/24/solid'
import { useEffect, useState } from 'react'
import { apiFetch } from '../../../../utils/apiFetch'
import { Spinner } from '../../../../components/Spinner'
import { DropdownMenu, DropdownMenuItem } from '../../../../components/DropdownMenu'
import { DeferredImage } from '../../../../components/DeferredImage'
import { buildLocalImageFolderScene, buildLocalImageScene } from '../Scenes/sceneShortcuts'
import { v4 as uuidv4 } from 'uuid'

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
  imageToken,
  createImageScene,
  createImageFolderScene,
}: {
  node: AssetNode
  frameId: number
  openAsset: (path: string) => void
  uploadAssets: (path: string) => void
  deleteAsset: (path: string) => void
  renameAsset: (oldPath: string, newPath: string) => void
  createFolder: (path: string) => void
  imageToken: string | null
  createImageScene: (path: string) => void
  createImageFolderScene: (path: string) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(node.path === '')
  const [isDownloading, setIsDownloading] = useState(false)

  // If this node is a folder, display a collapsible section
  if (node.isFolder) {
    return (
      <div className="ml-1">
        <div className="flex items-center space-x-1">
          <span className="cursor-pointer" onClick={() => setExpanded(!expanded)}>
            {expanded ? '📂' : '📁'} <span className="hover:underline text-blue-400">{node.name || '/'}</span>
          </span>
          <span className="text-xs text-gray-400"> ({Object.keys(node.children).length} items)</span>
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
          <div className="ml-2 border-l border-gray-600 pl-2">
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
                imageToken={imageToken}
                createImageScene={createImageScene}
                createImageFolderScene={createImageFolderScene}
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
    return (
      <div className="ml-1 flex items-center space-x-2">
        {isImage && imageToken && !node.path.startsWith('.thumbs/') && !node.path.includes('/.thumbs/') && (
          <div className="w-8 h-8">
            <DeferredImage
              url={`/api/frames/${frameId}/asset?path=${encodeURIComponent(node.path)}&thumb=1`}
              token={imageToken}
              className="w-8 h-8 object-cover border border-gray-600 rounded"
              spinnerClassName="w-4 h-4"
            />
          </div>
        )}
        <div className="flex-1">
          <span className="cursor-pointer hover:underline text-white" onClick={() => openAsset(node.path)}>
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
        {node.size && node.size > 0 && <span className="text-xs text-gray-400">{humaniseSize(node.size)}</span>}
        {node.mtime && node.mtime > 0 && (
          <span className="text-xs text-gray-500" title={new Date(node.mtime * 1000).toLocaleString()}>
            {new Date(node.mtime * 1000).toLocaleString()}
          </span>
        )}
        {(node.size === -1 && node.mtime === -1) || isDownloading ? (
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
                const resource = await apiFetch(`/api/frames/${frameId}/asset?path=${encodeURIComponent(node.path)}`)
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

export function Assets(): JSX.Element {
  const { frame, frameForm } = useValues(frameLogic)
  const { sendEvent } = useActions(frameLogic)
  const { openLogs } = useActions(panelsLogic)
  const { assetsLoading, assetTree } = useValues(assetsLogic({ frameId: frame.id }))
  const { loadAssets, syncAssets, uploadAssets, deleteAsset, renameAsset, createFolder } = useActions(
    assetsLogic({ frameId: frame.id })
  )
  const { openAsset } = useActions(panelsLogic({ frameId: frame.id }))
  const [imageToken, setImageToken] = useState<string | null>(null)

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

  useEffect(() => {
    async function fetchToken(): Promise<void> {
      try {
        const resp = await apiFetch(`/api/frames/${frame.id}/image_token`)
        if (resp.ok) {
          const data = await resp.json()
          setImageToken(data.token)
        }
      } catch (error) {
        console.error(error)
      }
    }
    fetchToken()
  }, [frame.id])

  return (
    <div className="space-y-2">
      <div className="float-right mt-[-8px]">
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
      {assetsLoading && (!assetTree.children || Object.keys(assetTree.children).length === 0) ? (
        <div>
          <div className="float-right mr-2">
            <Spinner />
          </div>
          <div>Loading assets...</div>
        </div>
      ) : (
        <div>
          {assetsLoading ? (
            <div className="float-right mr-2">
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
            imageToken={imageToken}
            createImageScene={createImageScene}
            createImageFolderScene={createImageFolderScene}
          />
        </div>
      )}
    </div>
  )
}
