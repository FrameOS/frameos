import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { assetsLogic } from './assetsLogic'
import { panelsLogic } from '../panelsLogic'
import {
  CloudArrowDownIcon,
  DocumentArrowUpIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/solid'
import { useState } from 'react'
import { apiFetch } from '../../../../utils/apiFetch'
import { Spinner } from '../../../../components/Spinner'
import { DropdownMenu } from '../../../../components/DropdownMenu'

function humaniseSize(size: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  while (size > 1024 && unitIndex < units.length) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`
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
}: {
  node: AssetNode
  frameId: number
  openAsset: (path: string) => void
  uploadAssets: (path: string) => void
  deleteAsset: (path: string) => void
  renameAsset: (oldPath: string, newPath: string) => void
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
            items={[
              {
                label: 'Upload files',
                icon: <DocumentArrowUpIcon className="w-5 h-5" />,
                onClick: () => uploadAssets(node.path),
              },
              node.path && {
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
              },
              node.path && {
                label: 'Delete',
                confirm: 'Are you sure?',
                icon: <TrashIcon className="w-5 h-5" />,
                onClick: () => deleteAsset(node.path),
              },
            ]}
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
              />
            ))}
          </div>
        )}
      </div>
    )
  } else {
    // This is a file
    return (
      <div className="ml-1 flex items-center space-x-2">
        <div className="flex-1">
          <span className="cursor-pointer hover:underline text-white" onClick={() => openAsset(node.path)}>
            {node.name}
          </span>
        </div>
        {node.size && node.size > 0 && <span className="text-xs text-gray-400">{humaniseSize(node.size)}</span>}
        {node.mtime && node.mtime > 0 && (
          <span className="text-xs text-gray-500" title={new Date(node.mtime * 1000).toLocaleString()}>
            {new Date(node.mtime * 1000).toLocaleString()}
          </span>
        )}
        {node.size === -1 && node.mtime === -1 ? (
          <Spinner className="w-4 h-4" color="white" />
        ) : node.size === -2 && node.mtime === -2 ? (
          <span className="text-red-500">Upload error</span>
        ) : (
          <a
            className="text-gray-300 hover:text-white cursor-pointer"
            onClick={async (e) => {
              e.preventDefault()
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
            }}
          >
            {isDownloading ? (
              <Spinner className="w-4 h-4 inline-block" />
            ) : (
              <CloudArrowDownIcon className="w-4 h-4 inline-block" />
            )}
          </a>
        )}
        <DropdownMenu
          horizontal
          className="w-fit"
          buttonColor="none"
          items={[
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
  const { frame } = useValues(frameLogic)
  const { openLogs } = useActions(panelsLogic)
  const { assetsLoading, assetTree } = useValues(assetsLogic({ frameId: frame.id }))
  const { syncAssets, uploadAssets, deleteAsset, renameAsset } = useActions(
    assetsLogic({ frameId: frame.id })
  )
  const { openAsset } = useActions(panelsLogic({ frameId: frame.id }))

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
      {assetsLoading ? (
        <div>Loading assets...</div>
      ) : (
        <div>
          <TreeNode
            node={assetTree}
            frameId={frame.id}
            openAsset={openAsset}
            uploadAssets={uploadAssets}
            deleteAsset={deleteAsset}
            renameAsset={renameAsset}
          />
        </div>
      )}
    </div>
  )
}
