import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  ChevronRightIcon,
  DocumentIcon,
  FolderIcon,
  FolderPlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'

import { Button } from '../../../../components/Button'
import { Modal } from '../../../../components/Modal'
import { Spinner } from '../../../../components/Spinner'
import { TextInput } from '../../../../components/TextInput'
import { livePreviewLogic, readPreviewAsset, type PreviewAssetEntry } from './livePreviewLogic'
import type { FrameId } from '../../../../types'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.qoi']

export function isImageAssetPath(path: string): boolean {
  const lower = path.toLowerCase()
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

export function formatAssetSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The folder part of a relative asset path ('' at the root). */
export function assetParentFolder(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export function assetBaseName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

/** Entries directly inside `folder`, folders first, then files, by name. */
export function entriesInFolder(entries: PreviewAssetEntry[], folder: string): PreviewAssetEntry[] {
  return entries
    .filter((entry) => assetParentFolder(entry.path) === folder)
    .sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1
      }
      return assetBaseName(a.path).localeCompare(assetBaseName(b.path), undefined, { sensitivity: 'base' })
    })
}

/** MIME type for a thumbnail blob, by extension. */
function imageMimeType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) {
    return 'image/png'
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif'
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp'
  }
  if (lower.endsWith('.bmp')) {
    return 'image/bmp'
  }
  if (lower.endsWith('.svg')) {
    return 'image/svg+xml'
  }
  return 'image/jpeg'
}

// A thumbnail read out of the worker's folder on demand; the blob URL is
// revoked when the row goes away (or the file changes).
function AssetThumbnail({ frameId, entry }: { frameId: FrameId; entry: PreviewAssetEntry }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    readPreviewAsset(frameId, entry.path)
      .then((buffer) => {
        if (cancelled) {
          return
        }
        objectUrl = URL.createObjectURL(new Blob([buffer], { type: imageMimeType(entry.path) }))
        setUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) {
          setUrl(null)
        }
      })
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [frameId, entry.path, entry.mtime, entry.size])
  return url ? (
    <img src={url} alt="" className="h-12 w-16 shrink-0 rounded-md object-cover" />
  ) : (
    <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md bg-slate-500/10">
      <DocumentIcon className="h-5 w-5 opacity-50" />
    </div>
  )
}

/**
 * Manage the browser preview's asset folder: the files the running scene
 * sees at /srv/assets. The folder lives in this browser only (the worker's
 * IndexedDB-backed filesystem), never on a frame or a server.
 */
export function BrowserAssetsModal({ frameId }: { frameId: FrameId }): JSX.Element | null {
  const { previewAssetsOpen, previewAssets, previewAssetsInfo, previewAssetsLoading, previewAssetsError } = useValues(
    livePreviewLogic({ frameId })
  )
  const {
    closePreviewAssets,
    loadPreviewAssets,
    uploadPreviewAssets,
    createPreviewAssetFolder,
    deletePreviewAsset,
    resetPreviewAssets,
  } = useActions(livePreviewLogic({ frameId }))

  const [folder, setFolder] = useState('')
  const [newFolderName, setNewFolderName] = useState<string | null>(null)
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Back to the root whenever the dialog opens; a folder deleted from under
  // us also falls back to the root.
  useEffect(() => {
    if (previewAssetsOpen) {
      setFolder('')
      setNewFolderName(null)
      setConfirmDeletePath(null)
      setConfirmReset(false)
    }
  }, [previewAssetsOpen])
  useEffect(() => {
    if (folder && !previewAssets.some((entry) => entry.isDir && entry.path === folder)) {
      setFolder('')
    }
  }, [folder, previewAssets])

  if (!previewAssetsOpen) {
    return null
  }

  const entries = entriesInFolder(previewAssets, folder)
  const totalBytes = previewAssets.reduce((sum, entry) => sum + entry.size, 0)
  const fileCount = previewAssets.filter((entry) => !entry.isDir).length
  const crumbs = folder ? folder.split('/') : []

  const addFiles = (files: FileList | File[] | null): void => {
    const list = files ? Array.from(files) : []
    if (list.length > 0) {
      uploadPreviewAssets(folder, list)
    }
  }
  const submitNewFolder = (): void => {
    const name = (newFolderName ?? '').trim().replace(/\//g, '')
    if (name && name !== '.' && name !== '..') {
      createPreviewAssetFolder(folder ? `${folder}/${name}` : name)
    }
    setNewFolderName(null)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    addFiles(event.dataTransfer?.files ?? null)
  }

  return (
    <Modal open onClose={closePreviewAssets} title="Browser assets" panelClassName="max-w-[720px]" align="top">
      <div className="space-y-4 p-5">
        <div className="rounded-lg border border-blue-400/40 bg-blue-500/10 p-3 text-sm">
          <p>
            This is a temporary asset folder that exists <strong>only in this browser</strong> — it is never sent to a
            frame or to the cloud. The preview runs scenes with it mounted at <code>/srv/assets</code>, the path a real
            frame keeps its assets at, so image scenes have something to show and apps that save files have somewhere to
            put them.{' '}
            {previewAssetsInfo?.persistent === false
              ? 'This browser blocks persistent storage, so the folder lives in memory and is gone when the preview closes.'
              : 'It is kept in this browser between previews and shared by every preview you open here.'}
          </p>
          <p className="mt-1 opacity-80">
            A fresh folder starts with a few generated sample photos. Add your own images to test slideshows and
            local-image scenes; put the same files on the frame itself for the real thing.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="small"
            color="secondary"
            className="flex items-center gap-1"
            onClick={() => fileInputRef.current?.click()}
          >
            <ArrowUpTrayIcon className="h-4 w-4" />
            Add files
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            data-testid="browser-assets-file-input"
            onChange={(event) => {
              addFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <Button
            size="small"
            color="secondary"
            className="flex items-center gap-1"
            onClick={() => setNewFolderName('')}
            disabled={newFolderName !== null}
          >
            <FolderPlusIcon className="h-4 w-4" />
            New folder
          </Button>
          <Button
            size="small"
            color="secondary"
            className="flex items-center gap-1"
            onClick={loadPreviewAssets}
            disabled={previewAssetsLoading}
            title="Reload the folder listing"
          >
            <ArrowPathIcon className={clsx('h-4 w-4', previewAssetsLoading && 'animate-spin')} />
            Refresh
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {confirmReset ? (
              <>
                <span className="text-sm">Delete everything and regenerate the samples?</span>
                <Button
                  size="small"
                  color="red"
                  onClick={() => {
                    setConfirmReset(false)
                    resetPreviewAssets()
                  }}
                >
                  Reset folder
                </Button>
                <Button size="small" color="secondary" onClick={() => setConfirmReset(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="small"
                color="secondary"
                onClick={() => setConfirmReset(true)}
                title="Delete everything in the folder and regenerate the sample photos"
              >
                Reset to samples
              </Button>
            )}
          </div>
        </div>

        {previewAssetsError ? (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {previewAssetsError}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            className={clsx('rounded px-1 hover:underline', !folder && 'font-semibold')}
            onClick={() => setFolder('')}
          >
            /srv/assets
          </button>
          {crumbs.map((crumb, index) => {
            const path = crumbs.slice(0, index + 1).join('/')
            return (
              <span key={path} className="flex items-center gap-1">
                <ChevronRightIcon className="h-3 w-3 opacity-60" />
                <button
                  type="button"
                  className={clsx('rounded px-1 hover:underline', index === crumbs.length - 1 && 'font-semibold')}
                  onClick={() => setFolder(path)}
                >
                  {crumb}
                </button>
              </span>
            )
          })}
        </div>

        <div
          className={clsx(
            'max-h-[50vh] min-h-[8rem] overflow-y-auto rounded-lg border p-1',
            dragging ? 'border-blue-400 bg-blue-500/10' : 'border-white/10'
          )}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          data-testid="browser-assets-list"
        >
          {newFolderName !== null ? (
            <div className="flex items-center gap-2 p-2">
              <FolderIcon className="h-5 w-5 shrink-0 opacity-70" />
              <TextInput
                autoFocus
                value={newFolderName}
                onChange={(value) => setNewFolderName(value)}
                placeholder="Folder name"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    submitNewFolder()
                  } else if (event.key === 'Escape') {
                    setNewFolderName(null)
                  }
                }}
              />
              <Button size="small" color="primary" onClick={submitNewFolder}>
                Create
              </Button>
              <Button size="small" color="secondary" onClick={() => setNewFolderName(null)}>
                Cancel
              </Button>
            </div>
          ) : null}
          {previewAssetsLoading && previewAssets.length === 0 ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm">
              <Spinner />
              Reading the browser folder…
            </div>
          ) : entries.length === 0 && newFolderName === null ? (
            <div className="p-6 text-center text-sm opacity-70">
              This folder is empty. Drop files here, or use “Add files”.
            </div>
          ) : (
            entries.map((entry) => {
              const name = assetBaseName(entry.path)
              const confirming = confirmDeletePath === entry.path
              return (
                <div
                  key={entry.path}
                  className="flex items-center gap-3 rounded-md p-2 hover:bg-slate-500/10"
                  data-testid="browser-asset-row"
                >
                  {entry.isDir ? (
                    <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md bg-slate-500/10">
                      <FolderIcon className="h-6 w-6 opacity-70" />
                    </div>
                  ) : isImageAssetPath(entry.path) ? (
                    <AssetThumbnail frameId={frameId} entry={entry} />
                  ) : (
                    <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md bg-slate-500/10">
                      <DocumentIcon className="h-5 w-5 opacity-50" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    {entry.isDir ? (
                      <button
                        type="button"
                        className="block max-w-full truncate text-left font-medium hover:underline"
                        onClick={() => setFolder(entry.path)}
                      >
                        {name}/
                      </button>
                    ) : (
                      <div className="truncate font-medium" title={entry.path}>
                        {name}
                      </div>
                    )}
                    <div className="text-xs opacity-60">
                      {entry.isDir ? 'Folder' : formatAssetSize(entry.size)}
                      {entry.mtime ? ` · ${new Date(entry.mtime).toLocaleString()}` : ''}
                    </div>
                  </div>
                  {confirming ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="tiny"
                        color="red"
                        onClick={() => {
                          setConfirmDeletePath(null)
                          deletePreviewAsset(entry.path)
                        }}
                      >
                        Delete{entry.isDir ? ' folder' : ''}
                      </Button>
                      <Button size="tiny" color="secondary" onClick={() => setConfirmDeletePath(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="tiny"
                      color="secondary"
                      className="!px-2 shrink-0"
                      title={entry.isDir ? 'Delete this folder and everything in it' : 'Delete this file'}
                      onClick={() => setConfirmDeletePath(entry.path)}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between text-xs opacity-70">
          <span>
            {fileCount} file{fileCount === 1 ? '' : 's'}, {formatAssetSize(totalBytes)}
            {previewAssetsInfo?.maxBytes ? ` of ${formatAssetSize(previewAssetsInfo.maxBytes)}` : ''}
          </span>
          <span>Stored in this browser only</span>
        </div>
      </div>
    </Modal>
  )
}
