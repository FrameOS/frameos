import { useState } from 'react'
import { useValues } from 'kea'
import { DocumentIcon, FolderIcon, FolderOpenIcon } from '@heroicons/react/24/outline'
import { assetsLogic, AssetNode } from './assetsLogic'
import { frameLogic } from '../../frameLogic'
import { isEsp32Frame } from '../../../workspace/workspaceSurfaces'
import { Button } from '../../../../components/Button'
import { Modal } from '../../../../components/Modal'
import { Spinner } from '../../../../components/Spinner'
import { TextInput } from '../../../../components/TextInput'
import type { FrameId, PathFieldPick } from '../../../../types'

export interface PathInputProps {
  frameId: FrameId
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** What the picker offers. Defaults to 'file'. */
  pick?: PathFieldPick
  /** Allowed file extensions without the dot; empty/absent means any file. */
  extensions?: string[]
  theme?: 'node' | 'full'
}

export function normalizeAssetsRoot(assetsPath?: string | null): string {
  return (assetsPath || '/srv/assets').replace(/\/+$/, '') || '/srv/assets'
}

/**
 * ESP32 frames mount the SD card at the assets root, so "/srv/assets/photos"
 * is an implementation detail there — the user thinks "sd://photos". The
 * stored value stays the real path (apps use it verbatim on every platform);
 * only the input renders the sd:// spelling.
 */
export function pathToDisplay(value: string, root: string, sdScheme: boolean): string {
  if (!sdScheme || !value) {
    return value
  }
  if (value === root) {
    return 'sd://'
  }
  if (value.startsWith(`${root}/`)) {
    return `sd://${value.slice(root.length + 1)}`
  }
  return value
}

export function displayToPath(display: string, root: string): string {
  if (display.startsWith('sd://')) {
    const rest = display.slice('sd://'.length).replace(/^\/+/, '')
    return rest ? `${root}/${rest}` : root
  }
  return display
}

function fileMatchesExtensions(name: string, extensions?: string[]): boolean {
  if (!extensions || extensions.length === 0) {
    return true
  }
  const lowerName = name.toLowerCase()
  return extensions.some((extension) => lowerName.endsWith(`.${extension.replace(/^\.+/, '').toLowerCase()}`))
}

function nodeAtPath(root: AssetNode, relativePath: string): AssetNode | null {
  let node = root
  for (const part of relativePath.split('/').filter(Boolean)) {
    const child = node.children[part]
    if (!child) {
      return null
    }
    node = child
  }
  return node
}

interface PathPickerModalProps {
  frameId: FrameId
  root: string
  sdScheme: boolean
  pick: PathFieldPick
  extensions?: string[]
  initialPath: string
  onSelect: (absolutePath: string) => void
  onClose: () => void
}

function PathPickerModal({
  frameId,
  root,
  sdScheme,
  pick,
  extensions,
  initialPath,
  onSelect,
  onClose,
}: PathPickerModalProps): JSX.Element {
  const { assetTree, assetsLoading, storageUnmounted } = useValues(assetsLogic({ frameId }))
  const [currentPath, setCurrentPath] = useState(() => {
    // Start where the current value points: in that folder, or a file's parent.
    if (!initialPath.startsWith(`${root}/`)) {
      return ''
    }
    return initialPath.slice(root.length + 1)
  })

  const selectedRelative = initialPath.startsWith(`${root}/`) ? initialPath.slice(root.length + 1) : ''
  let currentNode = nodeAtPath(assetTree, currentPath)
  let effectivePath = currentPath
  if (currentNode && !currentNode.isFolder) {
    effectivePath = currentPath.split('/').slice(0, -1).join('/')
    currentNode = nodeAtPath(assetTree, effectivePath)
  }
  if (!currentNode) {
    effectivePath = ''
    currentNode = assetTree
  }

  const rootLabel = sdScheme ? 'sd://' : root
  const breadcrumbParts = effectivePath.split('/').filter(Boolean)
  const children = Object.values(currentNode.children).sort((a, b) => {
    if (a.isFolder !== b.isFolder) {
      return a.isFolder ? -1 : 1
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })
  const visibleChildren = children.filter(
    (child) => child.isFolder || (pick !== 'folder' && fileMatchesExtensions(child.name, extensions))
  )
  const absoluteFor = (relativePath: string): string => (relativePath ? `${root}/${relativePath}` : root)
  const folderSelectable = pick === 'folder' || pick === 'any'

  return (
    <Modal
      open
      align="top"
      onClose={onClose}
      title={pick === 'folder' ? 'Pick a folder' : pick === 'any' ? 'Pick a file or folder' : 'Pick a file'}
      footer={
        <div className="frameos-divider flex items-center justify-end gap-2 border-t p-4">
          <Button color="secondary" onClick={onClose}>
            Cancel
          </Button>
          {folderSelectable ? (
            <Button color="primary" onClick={() => onSelect(absoluteFor(effectivePath))}>
              Use this folder
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button
            className="frameos-primary-text hover:underline"
            onClick={() => setCurrentPath('')}
            title={rootLabel}
          >
            {rootLabel}
          </button>
          {breadcrumbParts.map((part, index) => (
            <span key={index} className="flex items-center gap-1">
              {index > 0 || !sdScheme ? <span className="frameos-muted">/</span> : null}
              <button
                className="frameos-primary-text hover:underline"
                onClick={() => setCurrentPath(breadcrumbParts.slice(0, index + 1).join('/'))}
              >
                {part}
              </button>
            </span>
          ))}
        </div>
        {storageUnmounted ? (
          <div className="text-sm text-amber-500">The frame reports its storage as not mounted.</div>
        ) : null}
        {/* Fixed height on purpose: paired with the modal's top alignment,
            the dialog keeps one size and position while browsing instead of
            resizing and recentering with every folder's contents. */}
        <div className="h-[45vh] space-y-0.5 overflow-y-auto">
          {effectivePath ? (
            <button
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-blue-500/10"
              title="Up one level"
              onClick={() => setCurrentPath(breadcrumbParts.slice(0, -1).join('/'))}
            >
              <FolderIcon className="h-4 w-4 shrink-0 text-amber-500" />
              <span>..</span>
            </button>
          ) : null}
          {assetsLoading ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <Spinner className="h-4 w-4" /> Loading assets…
            </div>
          ) : visibleChildren.length === 0 ? (
            <div className="frameos-muted px-2 py-1.5 text-sm">
              {pick === 'folder' ? 'No folders here.' : 'Nothing to pick in this folder.'}
            </div>
          ) : (
            visibleChildren.map((child) => {
              const childPath = effectivePath ? `${effectivePath}/${child.name}` : child.name
              const isSelected = childPath === selectedRelative
              return (
                <button
                  key={child.path}
                  className={
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-blue-500/10 ' +
                    (isSelected ? 'bg-blue-500/20' : '')
                  }
                  onClick={() => {
                    if (child.isFolder) {
                      setCurrentPath(childPath)
                    } else {
                      onSelect(absoluteFor(childPath))
                    }
                  }}
                >
                  {child.isFolder ? (
                    <FolderIcon className="h-4 w-4 shrink-0 text-amber-500" />
                  ) : (
                    <DocumentIcon className="frameos-muted h-4 w-4 shrink-0" />
                  )}
                  <span className="truncate">{child.name}</span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Text input for 'path' fields with a browse button that opens a picker over
 * the frame's assets. The value is always a plain absolute path; ESP32 frames
 * render it with the sd:// spelling (see pathToDisplay).
 */
export function PathInput({
  frameId,
  value,
  onChange,
  placeholder,
  pick = 'file',
  extensions,
  theme,
}: PathInputProps): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  const { frame } = useValues(frameLogic({ frameId }))
  const sdScheme = isEsp32Frame(frame)
  const root = normalizeAssetsRoot(frame?.mode === 'buildroot' || sdScheme ? '/srv/assets' : frame?.assets_path)
  const stringValue = value === undefined || value === null ? '' : String(value)

  return (
    <div className="flex w-full items-center gap-1">
      <TextInput
        theme={theme}
        placeholder={placeholder || (sdScheme ? 'sd://' : root)}
        value={pathToDisplay(stringValue, root, sdScheme)}
        onChange={(newValue) => onChange(displayToPath(newValue, root))}
      />
      <Button
        size="small"
        color="secondary"
        title="Browse the frame's files"
        onClick={(e) => {
          e.stopPropagation()
          setPickerOpen(true)
        }}
      >
        <FolderOpenIcon className="h-4 w-4" />
      </Button>
      {pickerOpen ? (
        <PathPickerModal
          frameId={frameId}
          root={root}
          sdScheme={sdScheme}
          pick={pick}
          extensions={extensions}
          initialPath={stringValue || root}
          onSelect={(absolutePath) => {
            onChange(absolutePath)
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  )
}
