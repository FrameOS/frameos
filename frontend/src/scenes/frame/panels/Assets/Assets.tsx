import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { assetsLogic } from './assetsLogic'
import { panelsLogic } from '../panelsLogic'
import { CloudArrowDownIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { apiFetch } from '../../../../utils/apiFetch'
import { Spinner } from '../../../../components/Spinner'

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
}: {
  node: AssetNode
  frameId: number
  openAsset: (path: string) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(node.path === '')
  const [isDownloading, setIsDownloading] = useState(false)

  // If this node is a folder, display a collapsible section
  if (node.isFolder) {
    return (
      <div className="ml-1">
        <div className="cursor-pointer" onClick={() => setExpanded(!expanded)}>
          {expanded ? '📂' : '📁'} <span className="hover:underline text-blue-400">{node.name || '/'}</span>
        </div>
        {expanded && (
          <div className="ml-2 border-l border-gray-600 pl-2">
            {Object.values(node.children).map((child) => (
              <TreeNode key={child.path} node={child} frameId={frameId} openAsset={openAsset} />
            ))}
          </div>
        )}
      </div>
    )
  } else {
    // This is a file
    return (
      <div className="ml-1 flex items-center space-x-2">
        <div className="flex-1 cursor-pointer hover:underline text-white" onClick={() => openAsset(node.path)}>
          {node.name}
        </div>
        {node.size != null && <span className="text-xs text-gray-400">{humaniseSize(node.size)}</span>}
        {node.mtime && (
          <span className="text-xs text-gray-500" title={new Date(node.mtime * 1000).toLocaleString()}>
            {new Date(node.mtime * 1000).toLocaleString()}
          </span>
        )}

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
      </div>
    )
  }
}

export function Assets(): JSX.Element {
  const { frame } = useValues(frameLogic)
  const { assetsLoading, assetTree } = useValues(assetsLogic({ frameId: frame.id }))
  const { openAsset } = useActions(panelsLogic({ frameId: frame.id }))

  return (
    <div className="space-y-2">
      {assetsLoading ? (
        <div>Loading assets...</div>
      ) : (
        <div>
          <TreeNode node={assetTree} frameId={frame.id} openAsset={openAsset} />
        </div>
      )}
    </div>
  )
}
