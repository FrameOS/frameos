import { A } from 'kea-router'
import { useActions, useMountedLogic, useValues } from 'kea'
import clsx from 'clsx'
import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowPathRoundedSquareIcon,
  ArrowRightIcon,
  ArrowUpTrayIcon,
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  CheckIcon,
  ChevronRightIcon,
  ComputerDesktopIcon,
  UserIcon,
  DocumentIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  FolderPlusIcon,
  LinkIcon,
  ListBulletIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PhotoIcon,
  PlayIcon,
  RectangleStackIcon,
  Squares2X2Icon,
  PaintBrushIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { FrameosShell } from '../workspace/FrameosShell'
import { DropdownMenu, type DropdownMenuItem } from '../../components/DropdownMenu'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import { TextInput } from '../../components/TextInput'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { urls } from '../../urls'
import type { FrameId, FrameType } from '../../types'
import { inHassioIngress } from '../../utils/inHassioIngress'
import { isCloudMode } from '../../utils/cloudMode'
import { formatFrameRelativeTime, frameIsActive } from '../../decorators/frame'
import { photosLogic, type PhotoShowTarget, type PhotoUpload } from './photosLogic'
import {
  CUSTOM_SIZE_KEY,
  PNG_COLOR_CHOICES,
  RESIZE_FITS,
  RESIZE_FORMATS,
  photoResizeLogic,
  type ResizeSizeChoice,
} from './photoResizeLogic'
import { aspectMarkRect, type PhotoThumbnailFit } from './photoEntries'
import { photoColorsLogic } from './photoColorsLogic'
import {
  PREVIEW_SIZE_PRESETS,
  PREVIEW_SIZE_TARGET_KEY,
  type PhotoPreviewTarget,
  previewSizePresetKey,
  renderPhotoPreview,
} from './photoColors'
import { panelRenderSize } from '../../utils/assetColors/preview'
import {
  ColorEditorAdjustments,
  ColorEditorCanvas,
  ColorEditorFooter,
  ColorEditorViewControls,
} from '../frame/panels/Assets/ColorEditorModal'
import { Select } from '../../components/Select'
import {
  photoFileUrl,
  photoThumbUrl,
  shareUrlForFrame,
  type PhotoEntry,
  type PhotoShare,
  type PhotosStatus,
} from './photosApi'
import {
  dragHasFiles,
  dragHasPhotoPaths,
  getPhotoPathsDragData,
  setPhotoPathsDragData,
  takeDroppedItems,
} from './photoDrop'
import {
  humanFileSize,
  isBrowserImageName,
  isPhotoPathInside,
  photoAlbumOf,
  photoBaseName,
  photoCountLabel,
} from './photoPaths'

const iconButtonClassName =
  'frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'
const toolbarButtonClassName =
  'flex h-10 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50'

function formatDate(seconds: number): string {
  return seconds > 0 ? new Date(seconds * 1000).toLocaleString() : ''
}

/** Drop handling for anything that is a folder: moves photos dragged within
 * the page, uploads files dragged in from the desktop. */
function useFolderDrop(target: string): {
  isOver: boolean
  handlers: {
    onDragOver: (event: DragEvent) => void
    onDragLeave: (event: DragEvent) => void
    onDrop: (event: DragEvent) => void
  }
} {
  const { dropTarget, draggingPaths } = useValues(photosLogic)
  const { setDropTarget, moveEntries, uploadDroppedItems, endDrag } = useActions(photosLogic)
  // A folder cannot take itself or anything that contains it.
  const refuses = draggingPaths.some((path) => isPhotoPathInside(target, path))
  return {
    isOver: dropTarget === target && !refuses,
    handlers: {
      onDragOver: (event) => {
        const internal = dragHasPhotoPaths(event.dataTransfer)
        if ((!internal && !dragHasFiles(event.dataTransfer)) || (internal && refuses)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = internal ? 'move' : 'copy'
        if (dropTarget !== target) {
          setDropTarget(target)
        }
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return
        }
        if (dropTarget === target) {
          setDropTarget(null)
        }
      },
      onDrop: (event) => {
        event.preventDefault()
        event.stopPropagation()
        setDropTarget(null)
        const paths = getPhotoPathsDragData(event.dataTransfer)
        if (paths) {
          endDrag()
          moveEntries(paths, target)
          return
        }
        if (dragHasFiles(event.dataTransfer)) {
          uploadDroppedItems(target, takeDroppedItems(event.dataTransfer))
        }
      },
    },
  }
}

function PhotoThumb({
  entry,
  className,
  iconClassName = 'h-10 w-10',
  fit = 'cover',
}: {
  entry: PhotoEntry
  className?: string
  iconClassName?: string
  fit?: PhotoThumbnailFit
}): JSX.Element {
  // The thumbnail first; the photo itself when there is no thumbnail; an
  // icon when neither loads.
  const [stage, setStage] = useState<'thumb' | 'file' | 'icon'>(
    isBrowserImageName(entry.name) && entry.status !== 'blocked' ? 'thumb' : 'icon'
  )
  useEffect(() => {
    setStage(isBrowserImageName(entry.name) && entry.status !== 'blocked' ? 'thumb' : 'icon')
  }, [entry.path, entry.mtime, entry.size, entry.status])

  if (stage === 'icon') {
    const extension = entry.name.includes('.') ? entry.name.split('.').pop()?.toUpperCase() : null
    return (
      <div className={clsx('flex flex-col items-center justify-center gap-1 text-slate-400', className)}>
        {entry.status === 'blocked' ? (
          <ExclamationTriangleIcon className={clsx(iconClassName, 'text-red-500')} />
        ) : (
          <DocumentIcon className={iconClassName} />
        )}
        {extension && iconClassName !== 'h-5 w-5' ? (
          <span className="text-[10px] font-bold tracking-wide">{extension}</span>
        ) : null}
      </div>
    )
  }
  return (
    <img
      src={stage === 'thumb' ? photoThumbUrl(entry) : photoFileUrl(entry.path)}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setStage(stage === 'thumb' ? 'file' : 'icon')}
      className={clsx(fit === 'contain' ? 'object-contain' : 'object-cover', className)}
    />
  )
}

function FolderCover({
  entry,
  className,
  fit = 'cover',
}: {
  entry: PhotoEntry
  className?: string
  fit?: PhotoThumbnailFit
}): JSX.Element {
  const cover = entry.cover ?? null
  const [failed, setFailed] = useState<string | null>(null)
  // The cover before this one stays underneath while the new one fades in:
  // an upload in progress moves an album's cover along with each photo.
  const [shown, setShown] = useState<{ previous: string | null; current: string | null }>({
    previous: null,
    current: cover,
  })
  const [loaded, setLoaded] = useState<string | null>(null)
  useEffect(() => {
    setShown((state) => (state.current === cover ? state : { previous: state.current, current: cover }))
  }, [cover])
  const fitClassName = fit === 'contain' ? 'object-contain' : 'object-cover'
  if (!shown.current || failed === shown.current) {
    return (
      <div className={clsx('flex items-center justify-center', className)}>
        <FolderIcon className="frameos-folder-icon h-1/2 w-1/2 max-h-12 max-w-12" />
      </div>
    )
  }
  return (
    <div className={clsx('relative overflow-hidden', className)}>
      {shown.previous && shown.previous !== failed && loaded !== shown.current ? (
        <img
          key={shown.previous}
          src={photoThumbUrl({ path: shown.previous, mtime: entry.mtime, size: entry.size })}
          alt=""
          draggable={false}
          className={clsx('absolute inset-0 h-full w-full', fitClassName)}
        />
      ) : null}
      <img
        key={shown.current}
        src={photoThumbUrl({ path: shown.current, mtime: entry.mtime, size: entry.size })}
        alt=""
        loading="lazy"
        draggable={false}
        onLoad={() => setLoaded(shown.current)}
        onError={() => setFailed(shown.current)}
        className={clsx(
          'absolute inset-0 h-full w-full transition-opacity duration-500',
          fitClassName,
          loaded === shown.current ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  )
}

/** A small outline with the photo's aspect ratio, next to its dimensions. */
function AspectMark({ width, height }: { width: number; height: number }): JSX.Element {
  const box = 14
  const rect = aspectMarkRect(width, height, box)
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} className="shrink-0 opacity-70" aria-hidden="true">
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}

function SidebarFolderRow({
  path,
  label,
  description,
  icon,
  active,
  shared,
}: {
  path: string
  label: string
  description: string
  icon: ReactNode
  active: boolean
  shared?: boolean
}): JSX.Element {
  const { setFolder, openShare } = useActions(photosLogic)
  const { isOver, handlers } = useFolderDrop(path)
  return (
    <a
      href={urls.photos(path)}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return
        }
        event.preventDefault()
        setFolder(path)
      }}
      {...handlers}
      className={clsx(
        'frameos-frame-tool-row flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active ? 'frameos-frame-tool-row-selected' : 'text-slate-700 hover:bg-slate-100',
        isOver && 'frameos-primary-drop-target'
      )}
    >
      <span
        className={clsx(
          'frameos-frame-tool-icon flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl',
          active ? 'frameos-frame-tool-icon-selected' : 'bg-slate-100 text-slate-500'
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{label}</span>
        <span className={clsx('frameos-frame-tool-description block truncate text-xs', !active && 'text-slate-400')}>
          {description}
        </span>
      </span>
      {shared ? (
        // Inside the row's link, so not a <button>: it opens the share
        // dialog instead of the folder.
        <span
          role="button"
          tabIndex={0}
          title="Share link"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            openShare(path)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation()
              openShare(path)
            }
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg opacity-60 hover:bg-slate-200/60 hover:opacity-100"
        >
          <LinkIcon className="h-4 w-4" aria-label="Shared" />
        </span>
      ) : null}
    </a>
  )
}

function StorageMeter({ status }: { status: PhotosStatus }): JSX.Element {
  const limit = status.quota_bytes ?? (status.free_bytes !== null ? status.used_bytes + status.free_bytes : null)
  const percent = limit ? Math.min(100, Math.max(0, (status.used_bytes / limit) * 100)) : null
  const cloud = isCloudMode()
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="frameos-muted font-semibold uppercase tracking-wide">Storage</span>
        <span className="frameos-strong font-semibold">
          {humanFileSize(status.used_bytes) || '0 B'}
          {status.quota_bytes !== null ? (
            <span className="frameos-muted font-normal"> of {humanFileSize(status.quota_bytes)}</span>
          ) : null}
        </span>
      </div>
      {percent !== null ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-400/20">
          <div className="frameos-primary-fill h-full rounded-full" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {status.quota_bytes === null && status.free_bytes !== null ? (
        <div className="frameos-muted mt-1.5 truncate">{humanFileSize(status.free_bytes)} free on disk</div>
      ) : null}
      {status.location ? (
        <div className="frameos-muted mt-1 break-all font-mono text-[11px]">{status.location}</div>
      ) : null}
    </>
  )
  if (cloud) {
    // On the cloud the quota is the account's: the box is the way to the
    // usage page, where it is explained and can be raised.
    return (
      <A
        href={urls.accountUsage()}
        title="Your usage and quotas"
        className="frameos-inset block rounded-2xl border p-3 text-xs transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        {body}
        <div className="frameos-muted mt-1.5 flex items-center gap-1">
          See your usage
          <ChevronRightIcon className="h-3 w-3" />
        </div>
      </A>
    )
  }
  return <div className="frameos-inset rounded-2xl border p-3 text-xs">{body}</div>
}

function PhotosSidebar(): JSX.Element {
  const { albums, folder, status, sharesByPath, looseRootFileCount, folderEntries } = useValues(photosLogic)
  const { openNewFolder } = useActions(photosLogic)
  const currentAlbum = photoAlbumOf(folder)
  const rootLoaded = '' in folderEntries

  // A column that fills the panel: the storage box sits at the bottom, in
  // view whatever the album list's length, like Sign out under Settings.
  return (
    <div className="flex min-h-full flex-col gap-4">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="min-w-0">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">Photos</div>
          <div className="frameos-strong text-lg font-bold">Albums</div>
        </div>
        {status?.ready ? (
          <button
            type="button"
            title="New album"
            aria-label="New album"
            onClick={() => openNewFolder('')}
            className="frameos-primary-action flex h-10 w-10 items-center justify-center rounded-xl text-white shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <FolderPlusIcon className="h-5 w-5" />
          </button>
        ) : null}
      </div>
      {status?.ready ? (
        <>
          <div className="space-y-1">
            <SidebarFolderRow
              path=""
              label="Library"
              description={
                !rootLoaded
                  ? 'Loading'
                  : looseRootFileCount
                  ? `${albums.length} albums, ${photoCountLabel(looseRootFileCount)}`
                  : `${albums.length} ${albums.length === 1 ? 'album' : 'albums'}`
              }
              icon={<RectangleStackIcon className="h-5 w-5" />}
              active={folder === ''}
            />
          </div>
          <div className="space-y-1">
            {albums.map((album) => (
              <SidebarFolderRow
                key={album.path}
                path={album.path}
                label={album.name}
                description={photoCountLabel(album.files)}
                icon={
                  album.cover ? <FolderCover entry={album} className="h-10 w-10" /> : <FolderIcon className="h-5 w-5" />
                }
                active={currentAlbum === album.path}
                shared={!!sharesByPath[album.path]}
              />
            ))}
            {rootLoaded && albums.length === 0 ? (
              <div className="frameos-muted px-3 py-2 text-sm">No albums yet. Make one to start.</div>
            ) : null}
          </div>
          <div className="mt-auto pt-4">
            <StorageMeter status={status} />
          </div>
        </>
      ) : null}
    </div>
  )
}

function Breadcrumb({ name, path, last }: { name: string; path: string; last: boolean }): JSX.Element {
  const { setFolder } = useActions(photosLogic)
  const { isOver, handlers } = useFolderDrop(path)
  return (
    <a
      href={urls.photos(path)}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return
        }
        event.preventDefault()
        setFolder(path)
      }}
      {...handlers}
      className={clsx(
        'min-w-0 truncate rounded-lg border border-transparent px-2 py-1 transition',
        last ? 'frameos-strong font-bold' : 'frameos-muted font-semibold hover:underline',
        isOver && 'frameos-primary-drop-target'
      )}
    >
      {name}
    </a>
  )
}

function PhotosTopBar(): JSX.Element {
  const { breadcrumbs, folder, search, viewMode, thumbnailFit, selectedEntries, currentFolderLoading, status } =
    useValues(photosLogic)
  const {
    setSearch,
    setViewMode,
    setThumbnailFit,
    openNewFolder,
    uploadFiles,
    refresh,
    openInstallPicker,
    openShare,
    selectAll,
    selectByOrientation,
  } = useActions(photosLogic)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedFolders = selectedEntries.filter((entry) => entry.kind === 'folder').map((entry) => entry.path)
  const installAlbums = selectedFolders.length ? selectedFolders : folder ? [folder] : []

  return (
    // A container, so the labels drop by the room the sidebars leave, and the
    // controls wrap below the breadcrumbs as one group before a name is cut.
    <div className="photos-topbar @container mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex min-w-0 flex-[1_1_auto] items-center gap-0.5 text-lg" aria-label="Folder">
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.path || 'root'} className="flex min-w-0 items-center gap-0.5">
              {index > 0 ? <ChevronRightIcon className="frameos-muted h-4 w-4 shrink-0" /> : null}
              <Breadcrumb name={crumb.name} path={crumb.path} last={index === breadcrumbs.length - 1} />
            </span>
          ))}
          {currentFolderLoading ? <Spinner className="ml-2 h-4 w-4 shrink-0" /> : null}
        </nav>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          <div className="relative w-48 @5xl:w-56 max-sm:basis-full">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter this folder"
              className="frameos-input h-10 w-full rounded-xl border border-white/90 bg-white/90 pl-9 pr-3 text-sm shadow-sm outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div className="frameos-segment-group flex h-10 shrink-0 items-center rounded-xl p-1">
            {(
              [
                ['grid', Squares2X2Icon, 'Grid'],
                ['list', ListBulletIcon, 'List'],
              ] as const
            ).map(([mode, Icon, label]) => (
              <button
                key={mode}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={viewMode === mode}
                onClick={() => setViewMode(mode)}
                className={clsx(
                  'frameos-segment flex h-8 w-8 items-center justify-center rounded-lg transition',
                  viewMode === mode ? 'frameos-primary-soft-active' : 'text-slate-500'
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          <div className="frameos-segment-group flex h-10 shrink-0 items-center rounded-xl p-1">
            {(
              [
                ['cover', ArrowsPointingOutIcon, 'Fill the tiles'],
                ['contain', ArrowsPointingInIcon, 'Show whole photos'],
              ] as const
            ).map(([fit, Icon, label]) => (
              <button
                key={fit}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={thumbnailFit === fit}
                onClick={() => setThumbnailFit(fit)}
                className={clsx(
                  'frameos-segment flex h-8 w-8 items-center justify-center rounded-lg transition',
                  thumbnailFit === fit ? 'frameos-primary-soft-active' : 'text-slate-500'
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          <DropdownMenu
            // The menu's own trigger is a small pill; here it is a toolbar button like its neighbours.
            className="h-10 w-10 items-center !rounded-xl !px-0 !py-0"
            buttonColor="tertiary"
            items={
              [
                { label: 'Refresh', icon: <ArrowPathIcon className="h-5 w-5" />, onClick: refresh },
                folder
                  ? {
                      label: 'Share link',
                      icon: <LinkIcon className="h-5 w-5" />,
                      onClick: () => openShare(folder),
                    }
                  : null,
                {
                  label: 'Select all',
                  icon: <CheckIcon className="h-5 w-5" />,
                  onClick: selectAll,
                },
                {
                  label: 'Select all portrait',
                  icon: <AspectMark width={3} height={4} />,
                  onClick: () => selectByOrientation('portrait'),
                },
                {
                  label: 'Select all landscape',
                  icon: <AspectMark width={4} height={3} />,
                  onClick: () => selectByOrientation('landscape'),
                },
              ].filter(Boolean) as DropdownMenuItem[]
            }
          />
          <button
            type="button"
            onClick={() => openNewFolder(folder)}
            title="New folder"
            className={clsx(toolbarButtonClassName, 'frameos-secondary-button')}
          >
            <FolderPlusIcon className="h-5 w-5" />
            <span className="hidden @5xl:inline">New folder</span>
          </button>
          <button
            type="button"
            onClick={() => openInstallPicker(installAlbums)}
            title="Make scenes that play albums on a frame"
            className={clsx(toolbarButtonClassName, 'frameos-secondary-button')}
          >
            <ComputerDesktopIcon className="h-5 w-5" />
            <span className="hidden @3xl:inline">Install on frame</span>
          </button>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            title="Upload files"
            className={clsx(toolbarButtonClassName, 'frameos-primary-action text-white')}
          >
            <ArrowUpTrayIcon className="h-5 w-5" />
            <span className="hidden @lg:inline">Upload</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={status?.accepts ? status.accepts.join(',') : undefined}
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              if (files.length) {
                uploadFiles(folder, files)
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * "Show on frame", or, while a frame was used for it recently, "Show on
 * <that frame>" plus "Show on…" for any other.
 */
function showOnFrameItems(
  target: PhotoShowTarget,
  recent: FrameType | null,
  actions: {
    openShowPicker: (target: PhotoShowTarget) => void
    showOnFrame: (frameId: FrameId, target: PhotoShowTarget) => void
  }
): DropdownMenuItem[] {
  if (recent) {
    return [
      {
        label: `Show on ${recent.name || frameHost(recent)}`,
        icon: <PlayIcon className="h-5 w-5" />,
        onClick: () => actions.showOnFrame(recent.id, target),
      },
      {
        label: 'Show on…',
        icon: <ComputerDesktopIcon className="h-5 w-5" />,
        onClick: () => actions.openShowPicker(target),
      },
    ]
  }
  return [
    { label: 'Show on frame', icon: <PlayIcon className="h-5 w-5" />, onClick: () => actions.openShowPicker(target) },
  ]
}

function entryMenuItems(
  entry: PhotoEntry,
  recentShowFrame: FrameType | null,
  actions: {
    openEntry: (entry: PhotoEntry) => void
    openRename: (path: string) => void
    deleteEntries: (paths: string[]) => void
    openShare: (path: string) => void
    openInstallPicker: (albums: string[]) => void
    openColors: (path: string) => void
    openShowPicker: (target: PhotoShowTarget) => void
    showOnFrame: (frameId: FrameId, target: PhotoShowTarget) => void
    openResize: (paths: string[]) => void
  }
): DropdownMenuItem[] {
  if (entry.kind === 'folder') {
    return [
      { label: 'Open', icon: <FolderIcon className="h-5 w-5" />, onClick: () => actions.openEntry(entry) },
      ...showOnFrameItems({ albums: [entry.path], photo: null }, recentShowFrame, actions),
      {
        label: 'Install on frame',
        icon: <ComputerDesktopIcon className="h-5 w-5" />,
        onClick: () => actions.openInstallPicker([entry.path]),
      },
      { label: 'Share link', icon: <LinkIcon className="h-5 w-5" />, onClick: () => actions.openShare(entry.path) },
      {
        label: 'Rename',
        icon: <PencilSquareIcon className="h-5 w-5" />,
        onClick: () => actions.openRename(entry.path),
      },
      { label: 'Delete', icon: <TrashIcon className="h-5 w-5" />, onClick: () => actions.deleteEntries([entry.path]) },
    ]
  }
  const playable = isBrowserImageName(entry.name) && entry.status !== 'blocked'
  // A photo in the library root has no album to share, so no frame can show it.
  const inAlbum = entry.path.includes('/')
  return [
    playable
      ? { label: 'View', icon: <PhotoIcon className="h-5 w-5" />, onClick: () => actions.openEntry(entry) }
      : null,
    ...(playable && inAlbum ? showOnFrameItems({ albums: [], photo: entry.path }, recentShowFrame, actions) : []),
    playable
      ? {
          label: entry.colors ? 'Edit colors' : 'Set colors',
          icon: <PaintBrushIcon className="h-5 w-5" />,
          onClick: () => actions.openColors(entry.path),
        }
      : null,
    playable
      ? {
          label: 'Resize',
          icon: <ArrowsPointingInIcon className="h-5 w-5" />,
          onClick: () => actions.openResize([entry.path]),
        }
      : null,
    entry.status !== 'blocked'
      ? {
          label: 'Download',
          icon: <ArrowDownTrayIcon className="h-5 w-5" />,
          onClick: () => window.open(photoFileUrl(entry.path, true), '_blank', 'noopener,noreferrer'),
        }
      : null,
    { label: 'Rename', icon: <PencilSquareIcon className="h-5 w-5" />, onClick: () => actions.openRename(entry.path) },
    { label: 'Delete', icon: <TrashIcon className="h-5 w-5" />, onClick: () => actions.deleteEntries([entry.path]) },
  ].filter(Boolean) as DropdownMenuItem[]
}

function useEntryInteractions(entry: PhotoEntry, selected: boolean) {
  const { selectedPaths } = useValues(photosLogic)
  const { clickEntry, openEntry, startDrag, endDrag } = useActions(photosLogic)
  return {
    draggable: true,
    onClick: (event: MouseEvent) => {
      event.stopPropagation()
      clickEntry(entry, event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'none')
    },
    onDoubleClick: (event: MouseEvent) => {
      event.stopPropagation()
      openEntry(entry)
    },
    onDragStart: (event: DragEvent) => {
      const paths = selected ? selectedPaths : [entry.path]
      setPhotoPathsDragData(event.dataTransfer, paths)
      startDrag(paths)
    },
    onDragEnd: () => endDrag(),
  }
}

function SelectToggle({
  entry,
  selected,
  placement = 'tile',
}: {
  entry: PhotoEntry
  selected: boolean
  /** A tile's corner (shown on hover), or the front of a list row (always there). */
  placement?: 'tile' | 'row'
}): JSX.Element {
  const { selectEntry } = useActions(photosLogic)
  return (
    <button
      type="button"
      aria-label={selected ? `Deselect ${entry.name}` : `Select ${entry.name}`}
      onClick={(event) => {
        event.stopPropagation()
        selectEntry(entry.path, 'toggle')
      }}
      className={clsx(
        'photos-select-toggle z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 transition',
        placement === 'tile' ? 'absolute left-2 top-2 shadow' : 'shrink-0',
        selected
          ? 'frameos-primary-active border-transparent text-white'
          : placement === 'tile'
          ? 'border-white bg-black/20 text-transparent opacity-0 group-hover:opacity-100 focus:opacity-100'
          : 'border-slate-300 text-transparent hover:border-slate-500 hover:text-slate-400'
      )}
    >
      <CheckIcon className="h-4 w-4" />
    </button>
  )
}

function EntryMenu({ entry }: { entry: PhotoEntry }): JSX.Element {
  const { recentShowFrame } = useValues(photosLogic)
  const {
    openEntry,
    openRename,
    deleteEntries,
    openShare,
    openInstallPicker,
    openShowPicker,
    showOnFrame,
    openResize,
  } = useActions(photosLogic)
  const { openEditor } = useActions(photoColorsLogic)
  return (
    <div onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <DropdownMenu
        horizontal
        className="w-fit"
        buttonColor="tertiary"
        items={entryMenuItems(entry, recentShowFrame, {
          openEntry,
          openRename,
          openShowPicker,
          showOnFrame,
          openResize,
          deleteEntries,
          openShare,
          openInstallPicker,
          openColors: openEditor,
        })}
      />
    </div>
  )
}

function FolderTile({ entry, selected, shared }: { entry: PhotoEntry; selected: boolean; shared: boolean }) {
  const { thumbnailFit } = useValues(photosLogic)
  const interactions = useEntryInteractions(entry, selected)
  const { isOver, handlers } = useFolderDrop(entry.path)
  return (
    <div
      {...interactions}
      {...handlers}
      data-photo-path={entry.path}
      className={clsx(
        'photos-tile frameos-card group relative flex cursor-default select-none flex-col overflow-hidden rounded-2xl border border-white/90 bg-white/80 shadow-sm transition hover:shadow-lg',
        selected && 'frameos-selected-surface ring-2 ring-blue-400',
        isOver && 'frameos-primary-drop-target'
      )}
    >
      <SelectToggle entry={entry} selected={selected} />
      <div className="frameos-inset relative aspect-[4/3] w-full overflow-hidden bg-slate-100">
        <FolderCover entry={entry} className="h-full w-full" fit={thumbnailFit} />
        {entry.cover ? (
          <span className="absolute bottom-2 left-2 flex h-7 w-7 items-center justify-center rounded-lg bg-black/45 text-white">
            <FolderIcon className="h-4 w-4" />
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="frameos-strong truncate text-sm font-semibold" title={entry.name}>
            {entry.name}
          </div>
          <div className="frameos-muted flex items-center gap-1 truncate text-xs">
            {photoCountLabel(entry.files)}
            {shared ? <LinkIcon className="h-3 w-3" aria-label="Shared" /> : null}
          </div>
        </div>
        <EntryMenu entry={entry} />
      </div>
    </div>
  )
}

function FileTile({ entry, selected }: { entry: PhotoEntry; selected: boolean }) {
  const { thumbnailFit } = useValues(photosLogic)
  const interactions = useEntryInteractions(entry, selected)
  return (
    <div
      {...interactions}
      data-photo-path={entry.path}
      className={clsx(
        'photos-tile frameos-card group relative flex cursor-default select-none flex-col overflow-hidden rounded-2xl border border-white/90 bg-white/80 shadow-sm transition hover:shadow-lg',
        selected && 'frameos-selected-surface ring-2 ring-blue-400'
      )}
    >
      <SelectToggle entry={entry} selected={selected} />
      <div className="frameos-inset relative aspect-[4/3] w-full overflow-hidden bg-slate-100">
        <PhotoThumb entry={entry} className="h-full w-full" fit={thumbnailFit} />
        {entry.status === 'blocked' ? (
          <span className="absolute inset-x-2 bottom-2 rounded-lg bg-red-600/90 px-2 py-1 text-center text-xs font-semibold text-white">
            Blocked
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="frameos-strong flex items-center gap-1.5 text-sm font-semibold">
            <span className="truncate" title={entry.name}>
              {entry.name}
            </span>
            {entry.colors ? <ColorsMark /> : null}
          </div>
          <div className="frameos-muted truncate text-xs">
            {[humanFileSize(entry.size), entry.width && entry.height ? `${entry.width}×${entry.height}` : null]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <EntryMenu entry={entry} />
      </div>
    </div>
  )
}

function ListRow({ entry, selected, shared }: { entry: PhotoEntry; selected: boolean; shared: boolean }) {
  const interactions = useEntryInteractions(entry, selected)
  const drop = useFolderDrop(entry.path)
  // The grid's fill / whole-photo toggle applies here too, small as the thumbnails are.
  const { thumbnailFit } = useValues(photosLogic)
  const handlers = entry.kind === 'folder' ? drop.handlers : {}
  return (
    <div
      {...interactions}
      {...handlers}
      data-photo-path={entry.path}
      className={clsx(
        'photos-row group relative flex cursor-default select-none items-center gap-3 rounded-xl border border-transparent px-3 py-2 transition hover:bg-slate-100/70',
        selected && 'frameos-selected-surface ring-1 ring-blue-400',
        entry.kind === 'folder' && drop.isOver && 'frameos-primary-drop-target'
      )}
    >
      <SelectToggle entry={entry} selected={selected} placement="row" />
      <div className="frameos-inset relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100">
        {entry.kind === 'folder' ? (
          entry.cover ? (
            <>
              <FolderCover entry={entry} className="h-10 w-10" fit={thumbnailFit} />
              {/* The grid's mark: a cover alone looks like a photo. */}
              <span className="absolute bottom-0.5 left-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/45 text-white">
                <FolderIcon className="h-3 w-3" />
              </span>
            </>
          ) : (
            <FolderIcon className="frameos-folder-icon h-5 w-5" />
          )
        ) : (
          <PhotoThumb entry={entry} className="h-10 w-10" iconClassName="h-5 w-5" fit={thumbnailFit} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="frameos-strong flex items-center gap-1.5 truncate text-sm font-semibold">
          <span className="truncate" title={entry.name}>
            {entry.name}
          </span>
          {shared ? <LinkIcon className="h-3.5 w-3.5 shrink-0 opacity-60" aria-label="Shared" /> : null}
          {entry.colors ? <ColorsMark /> : null}
          {entry.status === 'blocked' ? <span className="text-xs font-semibold text-red-600">Blocked</span> : null}
        </div>
        <div className="frameos-muted truncate text-xs @3xl:hidden">
          {entry.kind === 'folder' ? photoCountLabel(entry.files) : humanFileSize(entry.size)}
        </div>
      </div>
      <div className="frameos-muted hidden w-24 shrink-0 text-right text-xs @3xl:block">
        {entry.kind === 'folder' ? photoCountLabel(entry.files) : humanFileSize(entry.size)}
      </div>
      <div className="frameos-muted hidden w-28 shrink-0 items-center justify-end gap-1.5 text-right text-xs @3xl:flex">
        {entry.width && entry.height ? (
          <>
            <AspectMark width={entry.width} height={entry.height} />
            <span>
              {entry.width}×{entry.height}
            </span>
          </>
        ) : null}
      </div>
      <div className="frameos-muted hidden w-44 shrink-0 text-right text-xs @5xl:block">{formatDate(entry.mtime)}</div>
      <EntryMenu entry={entry} />
    </div>
  )
}

function SelectionBar(): JSX.Element | null {
  const { selectedEntries, albums, folder } = useValues(photosLogic)
  const { clearSelection, deleteEntries, moveEntries, openRename, openInstallPicker, openResize } =
    useActions(photosLogic)
  if (!selectedEntries.length) {
    return null
  }
  const paths = selectedEntries.map((entry) => entry.path)
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null
  const folders = selectedEntries.filter((entry) => entry.kind === 'folder').map((entry) => entry.path)
  const resizable = selectedEntries
    .filter((entry) => entry.kind === 'file' && entry.status !== 'blocked' && isBrowserImageName(entry.name))
    .map((entry) => entry.path)
  const moveTargets = [
    { name: 'Library', path: '' },
    ...albums.map((album) => ({ name: album.name, path: album.path })),
  ].filter((target) => target.path !== folder && !paths.some((path) => isPhotoPathInside(target.path, path)))

  return (
    <div className="photos-selection-bar frameos-card mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-white/90 bg-white/90 px-3 py-2 shadow-sm">
      <button type="button" aria-label="Clear selection" onClick={clearSelection} className={iconButtonClassName}>
        <XMarkIcon className="h-5 w-5" />
      </button>
      <span className="frameos-strong mr-auto text-sm font-semibold">{selectedEntries.length} selected</span>
      {moveTargets.length ? (
        <DropdownMenu
          className="w-fit"
          buttonColor="tertiary"
          buttonContent={
            <span className="flex items-center gap-1.5 px-1 text-sm font-semibold">
              <ArrowRightIcon className="h-4 w-4" />
              Move to
            </span>
          }
          items={moveTargets.map((target) => ({
            label: target.name,
            icon: target.path ? <FolderIcon className="h-5 w-5" /> : <RectangleStackIcon className="h-5 w-5" />,
            onClick: () => moveEntries(paths, target.path),
          }))}
        />
      ) : null}
      {folders.length ? (
        <button
          type="button"
          onClick={() => openInstallPicker(folders)}
          className={clsx(toolbarButtonClassName, 'frameos-secondary-button h-9')}
        >
          <ComputerDesktopIcon className="h-4 w-4" />
          Install on frame
        </button>
      ) : null}
      {resizable.length ? (
        <button
          type="button"
          onClick={() => openResize(resizable)}
          className={clsx(toolbarButtonClassName, 'frameos-secondary-button h-9')}
        >
          <ArrowsPointingInIcon className="h-4 w-4" />
          {resizable.length > 1 ? `Resize all (${resizable.length})` : 'Resize'}
        </button>
      ) : null}
      {single && single.kind === 'file' && single.status !== 'blocked' ? (
        <a
          href={photoFileUrl(single.path, true)}
          className={clsx(toolbarButtonClassName, 'frameos-secondary-button h-9')}
          download={single.name}
        >
          <ArrowDownTrayIcon className="h-4 w-4" />
          Download
        </a>
      ) : null}
      {single ? (
        <button
          type="button"
          onClick={() => openRename(single.path)}
          className={clsx(toolbarButtonClassName, 'frameos-secondary-button h-9')}
        >
          <PencilSquareIcon className="h-4 w-4" />
          Rename
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => deleteEntries(paths)}
        className={clsx(toolbarButtonClassName, 'frameos-danger-button h-9')}
      >
        <TrashIcon className="h-4 w-4" />
        Delete
      </button>
    </div>
  )
}

function EmptyFolder({ isRoot }: { isRoot: boolean }): JSX.Element {
  const { openNewFolder } = useActions(photosLogic)
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="frameos-icon-tile flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <PhotoIcon className="h-8 w-8" />
      </span>
      <div className="frameos-strong text-lg font-semibold">{isRoot ? 'No photos yet' : 'This folder is empty'}</div>
      <p className="frameos-muted max-w-sm text-sm">
        {isRoot
          ? 'Make an album, then drop photos on it. Albums play on any frame with Install on frame.'
          : 'Drop photos or folders here, or use Upload.'}
      </p>
      {isRoot ? (
        <button
          type="button"
          onClick={() => openNewFolder('')}
          className={clsx(toolbarButtonClassName, 'frameos-primary-action text-white')}
        >
          <FolderPlusIcon className="h-5 w-5" />
          New album
        </button>
      ) : null}
    </div>
  )
}

function LoadingGrid(): JSX.Element {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3">
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className="frameos-skeleton-surface overflow-hidden rounded-2xl">
          <div className="frameos-skeleton-media aspect-[4/3] animate-pulse" />
          <div className="space-y-2 p-3">
            <div className="frameos-skeleton-line h-3 w-3/4 animate-pulse rounded-full" />
            <div className="frameos-skeleton-line h-2 w-1/2 animate-pulse rounded-full opacity-70" />
          </div>
        </div>
      ))}
    </div>
  )
}

function UploadPanel(): JSX.Element | null {
  const { uploads, activeUploadCount, uploadTotals } = useValues(photosLogic)
  const { dismissUploads } = useActions(photosLogic)
  if (!uploads.length) {
    return null
  }
  const failed = uploads.filter((upload) => upload.status === 'error')
  const done = uploads.filter((upload) => upload.status === 'done').length
  const percent = uploadTotals.size ? Math.round((uploadTotals.loaded / uploadTotals.size) * 100) : 100
  return (
    <div className="photos-upload-panel frameos-panel fixed bottom-5 right-5 z-30 w-[22rem] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-white/80 bg-white/95 p-4 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center gap-3">
        {activeUploadCount ? <Spinner className="h-5 w-5 shrink-0" /> : <CheckIcon className="h-5 w-5 shrink-0" />}
        <div className="frameos-strong min-w-0 flex-1 text-sm font-semibold">
          {activeUploadCount
            ? `Uploading ${Math.min(done + failed.length + 1, uploads.length)} of ${uploads.length}`
            : failed.length
            ? `${done} uploaded, ${failed.length} failed`
            : `${done} uploaded`}
        </div>
        {!activeUploadCount ? (
          <button type="button" aria-label="Close" onClick={dismissUploads} className={iconButtonClassName}>
            <XMarkIcon className="h-5 w-5" />
          </button>
        ) : null}
      </div>
      {activeUploadCount ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-400/20">
          <div className="frameos-primary-fill h-full rounded-full transition-all" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {failed.length ? (
        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-xs">
          {failed.map((upload: PhotoUpload) => (
            <li key={upload.id} className="flex gap-2">
              <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-red-500" />
              <span className="min-w-0">
                <span className="frameos-strong font-semibold">{upload.name}</span>{' '}
                <span className="frameos-muted">{upload.error}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function ColorsMark(): JSX.Element {
  return (
    <span title="Has colors" className="shrink-0">
      <PaintBrushIcon className="h-3.5 w-3.5 opacity-60" aria-label="Has colors" />
    </span>
  )
}

function previewTargetOptions(targets: PhotoPreviewTarget[]): {
  original: PhotoPreviewTarget[]
  frames: PhotoPreviewTarget[]
  panels: PhotoPreviewTarget[]
} {
  return {
    original: targets.filter((target) => target.group === 'original'),
    frames: targets.filter((target) => target.group === 'frames'),
    panels: targets.filter((target) => target.group === 'panels'),
  }
}

/** The size choices beside the palette: the target's own panel, a frame's, or a common size. */
function previewSizeOptions(frames: PhotoPreviewTarget[], framesList: FrameType[]) {
  return [
    { value: PREVIEW_SIZE_TARGET_KEY, label: 'Panel size' },
    ...(frames.length
      ? [
          {
            label: 'From a frame',
            options: frames.map((target) => {
              const frame = framesList.find((item) => `frame:${item.id}` === target.key)
              const size = frame ? panelRenderSize(frame) : { width: target.width, height: target.height }
              return { value: target.key, label: `${target.label} ${size.width}×${size.height}` }
            }),
          },
        ]
      : []),
    {
      label: 'Change size',
      options: PREVIEW_SIZE_PRESETS.map((preset) => ({
        value: previewSizePresetKey(preset),
        label: `${preset.width}×${preset.height} ${preset.label}`,
      })),
    },
  ]
}

type OverlayOption = { value: string; label: string } | { label: string; options: { value: string; label: string }[] }

/** A select in the lightbox's dark header: the shared Select carries the light theme. */
function OverlaySelect({
  value,
  onChange,
  options,
  title,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: OverlayOption[]
  title?: string
  className?: string
}): JSX.Element {
  return (
    <select
      value={value}
      title={title}
      onChange={(event) => onChange(event.target.value)}
      className={clsx(
        'h-9 rounded-xl border border-white/20 bg-white/10 px-2 text-sm text-white outline-none focus:ring-2 focus:ring-blue-400',
        className
      )}
    >
      {options.map((option) =>
        'options' in option ? (
          <optgroup key={option.label} label={option.label}>
            {option.options.map((child) => (
              <option key={child.value} value={child.value}>
                {child.label}
              </option>
            ))}
          </optgroup>
        ) : (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        )
      )}
    </select>
  )
}

/** Full fidelity, a frame, or a panel family: what the photo is previewed as, and at what size. */
function PreviewTargetSelect({ overlay = false }: { overlay?: boolean }): JSX.Element {
  const { previewTargets, previewTarget, previewSizeKey, fit } = useValues(photoColorsLogic)
  const { setPreviewTarget, setPreviewSize, rotatePreviewTarget, setFit } = useActions(photoColorsLogic)
  const { framesList } = useValues(framesModel)
  const { original, frames, panels } = previewTargetOptions(previewTargets)
  const sizeOptions = previewSizeOptions(frames, framesList)
  const fitOptions = [
    { value: 'cover', label: 'Fill' },
    { value: 'contain', label: 'Whole photo' },
  ]
  const onFit = (value: string): void => setFit(value === 'contain' ? 'contain' : 'cover')
  const sizeTitle = 'The size the photo is placed at'
  const fitTitle = 'How the photo meets the panel'
  const sizeControls =
    previewTarget.group !== 'original' ? (
      overlay ? (
        <>
          <OverlaySelect
            value={previewSizeKey}
            onChange={setPreviewSize}
            options={sizeOptions}
            title={sizeTitle}
            className="max-w-[12rem]"
          />
          <OverlaySelect value={fit} onChange={onFit} options={fitOptions} title={fitTitle} />
        </>
      ) : (
        <>
          <Select value={previewSizeKey} onChange={setPreviewSize} options={sizeOptions} title={sizeTitle} />
          <Select value={fit} onChange={onFit} options={fitOptions} title={fitTitle} />
        </>
      )
    ) : null
  const toOption = (target: PhotoPreviewTarget) => ({
    value: target.key,
    label: target.group === 'panels' ? `${target.label} panel` : target.label,
  })
  const options = [
    ...original.map(toOption),
    ...(frames.length ? [{ label: 'On a frame', options: frames.map(toOption) }] : []),
    { label: 'On a panel, 800×480', options: panels.map(toOption) },
  ]
  // A panel or frame can be turned on its side; the photo is placed in it again.
  const rotate =
    previewTarget.group !== 'original' ? (
      <button
        type="button"
        title={`Rotate, now ${previewTarget.width}×${previewTarget.height}`}
        aria-label="Rotate the panel"
        onClick={(event) => {
          event.stopPropagation()
          rotatePreviewTarget(previewTarget.key)
        }}
        className={clsx(
          'flex h-9 items-center gap-1 rounded-xl px-2 text-xs transition',
          overlay ? 'text-white/80 hover:bg-white/10' : 'frame-tool-muted hover:bg-slate-100'
        )}
      >
        <ArrowPathRoundedSquareIcon className="h-4 w-4" />
        <span>
          {previewTarget.width}×{previewTarget.height}
        </span>
      </button>
    ) : null
  if (!overlay) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="frame-tool-muted text-xs">Preview</span>
        <Select value={previewTarget.key} onChange={setPreviewTarget} options={options} />
        {sizeControls}
        {rotate}
      </span>
    )
  }
  return (
    <label className="flex items-center gap-2 text-xs text-white/70" onClick={(event) => event.stopPropagation()}>
      <span className="max-sm:hidden">View</span>
      <OverlaySelect
        value={previewTarget.key}
        onChange={setPreviewTarget}
        options={options}
        className="max-w-[14rem]"
      />
      {sizeControls}
      {rotate}
    </label>
  )
}

/** The "Set colors" editor, beside the photo in the lightbox. */
function PhotoColorsPanel(): JSX.Element {
  const values = useValues(photoColorsLogic)
  const actions = useActions(photoColorsLogic)
  const { saveAndOpenNext } = actions
  // Read up front: the proxy reads each key through a hook.
  const { imagePath, source, sourceLoading, sourceError } = values
  const fileName = imagePath ? photoBaseName(imagePath) : ''
  // Cmd/Ctrl+Enter is "Save & next" (just "Save" on the last photo), from a
  // slider or anywhere else in the lightbox.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        saveAndOpenNext()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  return (
    // Always the dark theme: the drawer sits in the black lightbox. The
    // theme class is on the wrapper, since the dark rules match descendants.
    <aside
      className="frameos-theme-dark frameos-dark-surface photos-colors-panel flex w-[24rem] max-w-[90vw] shrink-0"
      aria-label="Set colors"
    >
      <div className="frameos-panel frame-tool-panel flex min-h-0 w-full flex-col border-l backdrop-blur-xl">
        <div className="frameos-divider flex items-start gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="frameos-strong truncate text-lg font-semibold">Set colors</div>
            <div className="frame-tool-muted truncate text-xs">{fileName}</div>
          </div>
          <button
            type="button"
            title="Close"
            onClick={actions.closeEditor}
            className="frameos-icon-button flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        {!source && sourceLoading && !sourceError ? (
          // The photo and its sliders arrive together.
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Spinner className="h-8 w-8" />
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <ColorEditorViewControls values={values} actions={actions} className="text-xs" />
            <ColorEditorAdjustments values={values} actions={actions} />
            <p className="frame-tool-muted text-xs">
              Saved with the photo: every frame that plays it gets these colors. A panel's white is darker than a
              photo's; pull Whites down, or use Auto, to keep texture in bright areas. On a frame with automatic colors,
              saving Auto stores nothing, and each frame fits the photo to its own panel.
            </p>
          </div>
        )}
        <ColorEditorFooter
          values={values}
          actions={actions}
          variant="drawer"
          className="frameos-divider border-t p-3"
        />
      </div>
    </aside>
  )
}

/** The lightbox's photo as the chosen panel shows it, or graded at full fidelity. */
function LightboxPainted({ entry }: { entry: PhotoEntry }): JSX.Element {
  const values = useValues(photoColorsLogic)
  // Every key read here, in one place: the proxy reads each through a hook,
  // so a key read in one branch only would change the hook order.
  const {
    lightboxSource,
    lightboxSourceError,
    previewTarget,
    fit,
    imagePath,
    source: editorSource,
    sourceError: editorSourceError,
  } = values
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const workRef = useRef<HTMLCanvasElement | null>(null)
  const editing = imagePath === entry.path
  const source = editing ? null : lightboxSource?.path === entry.path ? lightboxSource : null

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !source) {
      return
    }
    const handle = window.requestAnimationFrame(() => {
      const work = (workRef.current ??= document.createElement('canvas'))
      const imageData = renderPhotoPreview(work, source, { target: previewTarget, fit, colors: entry.colors })
      if (imageData) {
        canvas.width = imageData.width
        canvas.height = imageData.height
        const context = canvas.getContext('2d')
        context?.putImageData(imageData, 0, 0)
        // A panel's edge, drawn on the pixels themselves: a letterboxed photo
        // would otherwise vanish into the black behind it, as if the size
        // had not changed. (The canvas box is larger than its contents.)
        if (context && previewTarget.group !== 'original') {
          context.strokeStyle = 'rgba(255, 255, 255, 0.35)'
          context.lineWidth = 1
          context.strokeRect(0.5, 0.5, imageData.width - 1, imageData.height - 1)
        }
      }
    })
    return () => window.cancelAnimationFrame(handle)
  }, [source, previewTarget, fit, entry.colors])

  const panel = previewTarget.group !== 'original'
  const painted = clsx('object-contain shadow-2xl', panel ? 'h-full w-full' : 'max-h-full max-w-full')
  if (editing) {
    // The editor's own preview: the sliders as they are now, not what is saved.
    if (editorSourceError) {
      return <div className="text-sm text-red-300">{editorSourceError}</div>
    }
    if (!editorSource) {
      return <Spinner className="h-8 w-8" color="white" />
    }
    return <ColorEditorCanvas values={values} className={painted} />
  }
  if (lightboxSourceError) {
    return <div className="text-sm text-red-300">{lightboxSourceError}</div>
  }
  if (!source) {
    return <Spinner className="h-8 w-8" color="white" />
  }
  return (
    <canvas
      ref={canvasRef}
      onClick={(event) => event.stopPropagation()}
      // A panel is scaled up to the room there is, pixel for pixel, so the
      // dither shows; a photo is never shown larger than it is. A ring marks
      // the panel's edge: a letterboxed photo would otherwise vanish into the
      // black behind it, as if the size had not changed.
      className={clsx('object-contain shadow-2xl', panel ? 'h-full w-full' : 'max-h-full max-w-full')}
      style={{ imageRendering: panel ? 'pixelated' : 'auto' }}
    />
  )
}

function Lightbox(): JSX.Element | null {
  const { lightboxEntry, lightboxEntries } = useValues(photosLogic)
  const { closeLightbox, stepLightbox, deleteEntries } = useActions(photosLogic)
  const { lightboxPainted, imagePath } = useValues(photoColorsLogic)
  const { openEditor, closeEditor } = useActions(photoColorsLogic)
  if (!lightboxEntry) {
    return null
  }
  const index = lightboxEntries.findIndex((entry) => entry.path === lightboxEntry.path)
  const editing = imagePath === lightboxEntry.path
  // Portalled to <body>: on the cloud the workspace sits in a wrapper with a
  // transform (cloud-frontend index.css), which makes it the containing block
  // for every fixed descendant, so an in-tree overlay would stop under the
  // account header. On <body> it covers the whole viewport, header included,
  // like the headless UI modals and the scene editor do.
  return createPortal(
    <div
      className="photos-lightbox fixed inset-0 z-[110] flex flex-col bg-black/95 text-white backdrop-blur-sm"
      role="dialog"
      aria-label={lightboxEntry.name}
    >
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{lightboxEntry.name}</div>
          <div className="truncate text-xs text-white/60">
            {[
              `${index + 1} of ${lightboxEntries.length}`,
              humanFileSize(lightboxEntry.size),
              lightboxEntry.width && lightboxEntry.height ? `${lightboxEntry.width}×${lightboxEntry.height}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        {isBrowserImageName(lightboxEntry.name) ? (
          <>
            <PreviewTargetSelect overlay />
            <button
              type="button"
              title={lightboxEntry.colors ? 'Edit colors' : 'Set colors'}
              aria-pressed={editing}
              onClick={() => (editing ? closeEditor() : openEditor(lightboxEntry.path))}
              className={clsx(
                'flex h-10 w-10 items-center justify-center rounded-xl hover:bg-white/10',
                editing ? 'bg-white/15' : lightboxEntry.colors && 'text-emerald-300'
              )}
            >
              <PaintBrushIcon className="h-5 w-5" />
            </button>
          </>
        ) : null}
        <a
          href={photoFileUrl(lightboxEntry.path, true)}
          download={lightboxEntry.name}
          title="Download"
          className="flex h-10 w-10 items-center justify-center rounded-xl hover:bg-white/10"
        >
          <ArrowDownTrayIcon className="h-5 w-5" />
        </a>
        <button
          type="button"
          title="Delete"
          onClick={() => deleteEntries([lightboxEntry.path])}
          className="flex h-10 w-10 items-center justify-center rounded-xl hover:bg-white/10"
        >
          <TrashIcon className="h-5 w-5" />
        </button>
        <button
          type="button"
          title="Close"
          onClick={closeLightbox}
          className="flex h-10 w-10 items-center justify-center rounded-xl hover:bg-white/10"
        >
          <XMarkIcon className="h-6 w-6" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-16 pb-8">
          {lightboxPainted ? (
            <LightboxPainted entry={lightboxEntry} />
          ) : (
            <img
              key={lightboxEntry.path}
              src={photoFileUrl(lightboxEntry.path)}
              alt={lightboxEntry.name}
              className="max-h-full max-w-full object-contain shadow-2xl"
            />
          )}
          {lightboxEntries.length > 1 ? (
            <>
              <button
                type="button"
                aria-label="Previous photo"
                onClick={() => stepLightbox(-1)}
                className="absolute left-4 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
              >
                <ArrowLeftIcon className="h-6 w-6" />
              </button>
              <button
                type="button"
                aria-label="Next photo"
                onClick={() => stepLightbox(1)}
                className="absolute right-4 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
              >
                <ArrowRightIcon className="h-6 w-6" />
              </button>
            </>
          ) : null}
        </div>
        {editing ? <PhotoColorsPanel /> : null}
      </div>
    </div>,
    document.body
  )
}

function NameDialog({
  title,
  label,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onClose,
}: {
  title: string
  label: string
  initial: string
  submitLabel: string
  busy: boolean
  onSubmit: (name: string) => void
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const input = inputRef.current
    if (!input) {
      return
    }
    input.focus()
    // Select the name without its extension, like a file manager does.
    const dot = initial.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [])
  return (
    <Modal title={title} onClose={onClose} panelClassName="max-w-[28rem]">
      <form
        className="space-y-4 p-5"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(name)
        }}
      >
        <label className="block space-y-1.5">
          <span className="frameos-form-label text-sm font-medium">{label}</span>
          <TextInput ref={inputRef} value={name} onChange={setName} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={clsx(toolbarButtonClassName, 'frameos-secondary-button')}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className={clsx(toolbarButtonClassName, 'frameos-primary-action text-white')}
          >
            {busy ? <Spinner className="h-4 w-4" color="white" /> : null}
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ShareDialog(): JSX.Element | null {
  const {
    shareTarget,
    shareTargetShares,
    shareBusy,
    sharesLoading,
    shareCopiedToken,
    shareFrameChoice,
    shareCustomName,
    shareStopToken,
  } = useValues(photosLogic)
  const {
    closeShare,
    createShare,
    deleteShare,
    markShareCopied,
    setShareFrameChoice,
    setShareCustomName,
    askStopSharing,
    cancelStopSharing,
  } = useActions(photosLogic)
  const { frames, framesList } = useValues(framesModel)
  if (shareTarget === null) {
    return null
  }
  const frameChoices = framesList.filter((frame) => !frame.archived)
  const describe = (share: PhotoShare): string =>
    share.name !== null
      ? share.name
      : share.frame_id === null
      ? 'Anyone with the link'
      : frames[share.frame_id]?.name ?? `Frame ${share.frame_id} (gone)`
  // The backend answers a path: a frame's own link gets that frame's address
  // for the backend, the others the page's origin. Behind Home Assistant the
  // page's origin is not that address.
  const linkFor = (share: PhotoShare): string => {
    if (/^https?:\/\//.test(share.url)) {
      return share.url
    }
    const frame = share.frame_id === null ? null : frames[share.frame_id]
    const fromFrame = frame ? shareUrlForFrame(share, frame) : null
    return fromFrame ?? (inHassioIngress() ? share.url : `${window.location.origin}${share.url}`)
  }
  const lastUsed = (share: PhotoShare): string => {
    const ago = share.last_used_at ? formatFrameRelativeTime(share.last_used_at * 1000) : null
    return ago ? `last used ${ago} ago` : 'never used'
  }
  const custom = shareFrameChoice === 'custom'
  const choiceTaken = custom
    ? false
    : shareFrameChoice === ''
    ? shareTargetShares.some((share) => share.name === null && share.frame_id === null)
    : shareTargetShares.some((share) => share.name === null && String(share.frame_id) === shareFrameChoice)
  const canCreate = !shareBusy && !sharesLoading && !choiceTaken && (!custom || shareCustomName.trim().length > 0)
  const create = (): void => {
    if (!canCreate) {
      return
    }
    if (custom) {
      createShare(shareTarget, null, shareCustomName.trim())
      return
    }
    const chosen = shareFrameChoice === '' ? null : frameChoices.find((frame) => String(frame.id) === shareFrameChoice)
    createShare(shareTarget, chosen ? chosen.id : null)
  }
  return (
    <Modal title={`Share "${photoBaseName(shareTarget)}"`} onClose={closeShare} panelClassName="max-w-[34rem]">
      <div className="space-y-4 p-5 text-sm">
        <p className="frameos-muted">
          Anyone with a link can see the photos in this folder. A frame plays the album through its own link, so you can
          stop one frame without touching the others. A custom link is one to give to a friend.
        </p>
        {shareTargetShares.length ? (
          <ul className="space-y-3">
            {shareTargetShares.map((share) => {
              const link = linkFor(share)
              const copied = shareCopiedToken === share.token
              const stopping = shareStopToken === share.token
              return (
                <li key={share.token} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    {share.name !== null ? (
                      <UserIcon className="h-4 w-4 shrink-0 opacity-60" />
                    ) : share.frame_id === null ? (
                      <LinkIcon className="h-4 w-4 shrink-0 opacity-60" />
                    ) : (
                      <ComputerDesktopIcon className="h-4 w-4 shrink-0 opacity-60" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{describe(share)}</span>
                      <span className="frameos-muted"> · {lastUsed(share)}</span>
                    </span>
                    {stopping ? (
                      <span className="flex items-center gap-1">
                        <span className="frameos-muted text-xs">Stop sharing?</span>
                        <button
                          type="button"
                          disabled={shareBusy}
                          onClick={() => deleteShare(share.token)}
                          className="rounded-lg bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          Stop
                        </button>
                        <button
                          type="button"
                          onClick={cancelStopSharing}
                          className="frameos-muted rounded-lg px-2 py-1 text-xs font-medium hover:bg-slate-200/60"
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={shareBusy}
                        title="Stop sharing through this link"
                        onClick={() => askStopSharing(share.token)}
                        className="rounded-lg px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-500/10"
                      >
                        Stop sharing
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={link}
                      onFocus={(event) => event.target.select()}
                      className="frameos-input h-9 min-w-0 flex-1 rounded-xl border px-3 font-mono text-xs"
                    />
                    <button
                      type="button"
                      title="Copy the link"
                      onClick={() => {
                        void navigator.clipboard?.writeText(link).then(() => markShareCopied(share.token))
                      }}
                      className={clsx(toolbarButtonClassName, 'frameos-secondary-button')}
                    >
                      {copied ? <CheckIcon className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="frameos-muted text-xs">This folder has no links yet.</p>
        )}
        {shareTargetShares.some((share) => share.frame_id === null && !/^https?:\/\//.test(share.url)) ? (
          <p className="frameos-muted text-xs">
            Frames reach a link for anyone through the backend address in their settings.
          </p>
        ) : null}
        <div className="frameos-divider space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="frameos-muted text-xs">New link for</span>
            <Select
              value={shareFrameChoice}
              onChange={setShareFrameChoice}
              className="h-9 min-w-[12rem] flex-1"
              options={[
                { value: '', label: 'Anyone with the link' },
                { value: 'custom', label: 'Custom (a friend, a place)' },
                ...frameChoices.map((frame) => ({ value: String(frame.id), label: frame.name || `Frame ${frame.id}` })),
              ]}
            />
            {!custom ? (
              <button
                type="button"
                disabled={!canCreate}
                title={choiceTaken ? 'That link exists already' : undefined}
                onClick={create}
                className={clsx(toolbarButtonClassName, 'frameos-primary-action text-white')}
              >
                {shareBusy ? <Spinner className="h-4 w-4" color="white" /> : <LinkIcon className="h-4 w-4" />}
                Create link
              </button>
            ) : null}
          </div>
          {custom ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                create()
              }}
            >
              <TextInput
                value={shareCustomName}
                onChange={setShareCustomName}
                placeholder="Who or what is this link for?"
                className="h-9 min-w-0 flex-1"
              />
              <button
                type="submit"
                disabled={!canCreate}
                className={clsx(toolbarButtonClassName, 'frameos-primary-action text-white')}
              >
                {shareBusy ? <Spinner className="h-4 w-4" color="white" /> : <LinkIcon className="h-4 w-4" />}
                Create link
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}

function InstallPicker(): JSX.Element | null {
  const { installPickerAlbums } = useValues(photosLogic)
  const { closeInstallPicker, installOnFrame } = useActions(photosLogic)
  if (installPickerAlbums === null) {
    return null
  }
  return (
    <FramePicker
      title="Install on frame"
      description={
        installPickerAlbums.length
          ? `Pick the frame that plays ${
              installPickerAlbums.length === 1
                ? `"${photoBaseName(installPickerAlbums[0])}"`
                : `these ${installPickerAlbums.length} albums`
            }. You choose the timing next.`
          : 'Pick a frame. You choose the albums and the timing next.'
      }
      onPick={installOnFrame}
      onClose={closeInstallPicker}
    />
  )
}

/** "Show on frame": the frame that shows the album, or the one photo, right away. */
function ShowPicker(): JSX.Element | null {
  const { showPickerTarget, saveShownScene } = useValues(photosLogic)
  const { closeShowPicker, showOnFrame, setSaveShownScene } = useActions(photosLogic)
  if (showPickerTarget === null) {
    return null
  }
  const what = showPickerTarget.photo
    ? `"${photoBaseName(showPickerTarget.photo)}"`
    : showPickerTarget.albums.length === 1
    ? `"${photoBaseName(showPickerTarget.albums[0])}"`
    : `these ${showPickerTarget.albums.length} albums`
  return (
    <FramePicker
      title="Show on frame"
      description={`Pick the frame that shows ${what} now.`}
      onPick={(frameId) => showOnFrame(frameId, showPickerTarget)}
      onClose={closeShowPicker}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={saveShownScene}
          onChange={(event) => setSaveShownScene(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="frameos-strong font-semibold">Save as a scene on the frame</span>
          <span className="frameos-muted block text-xs">
            {saveShownScene
              ? "The scene joins the frame's scenes and stays after it shows something else."
              : 'Otherwise the frame only previews it: it shows now, and the frame keeps the scenes it has.'}
          </span>
        </span>
      </label>
    </FramePicker>
  )
}

function FramePicker({
  title,
  description,
  onPick,
  onClose,
  children,
}: {
  title: string
  description: string
  onPick: (frameId: FrameId) => void
  onClose: () => void
  /** Options under the description, above the frames. */
  children?: ReactNode
}): JSX.Element {
  const { framesList } = useValues(framesModel)
  const frames = framesList.filter((frame) => !frame.archived)
  // The home page's split: a frame that is online, or was heard from
  // recently, above the ones that were not.
  const groups = [
    { title: 'Active', frames: frames.filter((frame) => frameIsActive(frame)) },
    { title: 'Inactive', frames: frames.filter((frame) => !frameIsActive(frame)) },
  ].filter((group) => group.frames.length)
  const lastSeen = (frame: FrameType): string | null => {
    const ago = formatFrameRelativeTime(frame.last_log_at ?? frame.last_seen_at)
    return ago ? `last seen ${ago} ago` : null
  }
  return (
    <Modal title={title} onClose={onClose} panelClassName="max-w-[28rem]">
      <div className="space-y-3 p-5">
        <p className="frameos-muted text-sm">{description}</p>
        {children}
        {frames.length ? (
          <div className="max-h-[50vh] space-y-3 overflow-y-auto">
            {groups.map((group) => (
              <div key={group.title} className="space-y-2">
                {groups.length > 1 ? (
                  <div className="frameos-muted px-1 text-[10px] font-semibold uppercase tracking-wide">
                    {group.title}
                  </div>
                ) : null}
                {group.frames.map((frame) => (
                  <button
                    key={frame.id}
                    type="button"
                    onClick={() => onPick(frame.id)}
                    className="frameos-card flex w-full items-center gap-3 rounded-xl border border-white/90 bg-white/80 px-3 py-2.5 text-left shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  >
                    <span className="frameos-icon-tile flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                      <ComputerDesktopIcon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="frameos-strong block truncate text-sm font-semibold">
                        {frame.name || frameHost(frame)}
                      </span>
                      <span className="frameos-muted block truncate text-xs">
                        {[
                          frame.width && frame.height ? `${frame.width}×${frame.height}` : frameHost(frame),
                          lastSeen(frame),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <ChevronRightIcon className="frameos-muted h-5 w-5 shrink-0" />
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="frameos-muted text-sm">Add a frame first.</div>
        )}
      </div>
    </Modal>
  )
}

function PhotosDialogs(): JSX.Element {
  const { newFolderParent, renameTarget, mutating } = useValues(photosLogic)
  const { closeNewFolder, createFolder, closeRename, renameEntry } = useActions(photosLogic)
  return (
    <>
      {newFolderParent !== null ? (
        <NameDialog
          title={newFolderParent ? 'New folder' : 'New album'}
          label="Name"
          initial=""
          submitLabel="Create"
          busy={mutating}
          onClose={closeNewFolder}
          onSubmit={(name) => createFolder(newFolderParent, name)}
        />
      ) : null}
      {renameTarget !== null ? (
        <NameDialog
          title="Rename"
          label="Name"
          initial={photoBaseName(renameTarget)}
          submitLabel="Rename"
          busy={mutating}
          onClose={closeRename}
          onSubmit={(name) => renameEntry(renameTarget, name)}
        />
      ) : null}
      <ShareDialog />
      <InstallPicker />
      <ShowPicker />
      <ResizeDialog />
    </>
  )
}

/** Resize one photo, or every selected one, in place: a size, how the photo meets it, the format. */
function ResizeDialog(): JSX.Element | null {
  const { resizeTargets, mutating } = useValues(photosLogic)
  const { closeResize, resizeEntries } = useActions(photosLogic)
  const { sizeKey, sizeChoices, width, height, fit, format, quality, upscale, background, colors, options, valid } =
    useValues(photoResizeLogic)
  const {
    setSize,
    setWidth,
    setHeight,
    swapSides,
    setFit,
    setFormat,
    setQuality,
    setUpscale,
    setBackground,
    setColors,
  } = useActions(photoResizeLogic)
  if (resizeTargets === null) {
    return null
  }
  const count = resizeTargets.length
  const groups: { label: string; group: ResizeSizeChoice['group'] }[] = [
    { label: 'From a frame', group: 'frames' },
    { label: 'Common sizes', group: 'presets' },
  ]
  const sizeOptions = [
    ...groups
      .map(({ label, group }) => ({
        label,
        options: sizeChoices
          .filter((choice) => choice.group === group)
          .map((choice) => ({ value: choice.key, label: choice.label })),
      }))
      .filter((group) => group.options.length),
    { value: CUSTOM_SIZE_KEY, label: 'Custom size' },
  ]
  const fitHint = RESIZE_FITS.find((item) => item.value === fit)?.hint
  const lossy = format === 'jpeg' || format === 'webp'
  const padsOrFlattens = fit === 'contain' || format === 'jpeg'
  const fieldClassName =
    'frameos-input h-10 rounded-xl border border-white/90 bg-white/90 px-3 text-sm shadow-sm outline-none focus:ring-2 focus:ring-blue-400'
  return (
    <Modal
      title={count === 1 ? `Resize "${photoBaseName(resizeTargets[0])}"` : `Resize ${count} photos`}
      onClose={closeResize}
      panelClassName="max-w-[32rem]"
    >
      <div className="space-y-4 p-5">
        <p className="frameos-muted text-sm">
          The photo is replaced with a smaller copy. Its colors and its place in the album stay; the original is gone.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="frameos-strong font-semibold">Size</span>
            <Select
              value={sizeKey}
              options={sizeOptions}
              onChange={(key) => {
                const choice = sizeChoices.find((item) => item.key === key)
                setSize(key, choice?.width ?? width, choice?.height ?? height)
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="frameos-strong font-semibold">Width</span>
            <input
              type="number"
              min={1}
              max={16384}
              value={width ?? ''}
              placeholder={fit === 'inside' ? 'any' : ''}
              onChange={(event) => setWidth(event.target.value === '' ? null : Number(event.target.value))}
              className={fieldClassName}
            />
          </label>
          <label className="relative flex flex-col gap-1 text-sm">
            {/* Turn the box on its side: a portrait frame from a landscape preset, in one click. */}
            <button
              type="button"
              onClick={swapSides}
              title="Swap width and height"
              aria-label="Swap width and height"
              className="frameos-icon-button absolute -left-[1.4rem] top-7 flex h-6 w-6 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
            >
              <ArrowPathRoundedSquareIcon className="h-4 w-4" />
            </button>
            <span className="frameos-strong font-semibold">Height</span>
            <input
              type="number"
              min={1}
              max={16384}
              value={height ?? ''}
              placeholder={fit === 'inside' ? 'any' : ''}
              onChange={(event) => setHeight(event.target.value === '' ? null : Number(event.target.value))}
              className={fieldClassName}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="frameos-strong font-semibold">How the photo meets the size</span>
            <Select
              value={fit}
              onChange={(value) => setFit(value as typeof fit)}
              options={RESIZE_FITS.map(({ value, label }) => ({ value, label }))}
            />
            {fitHint ? <span className="frameos-muted text-xs">{fitHint}</span> : null}
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={upscale} onChange={(event) => setUpscale(event.target.checked)} />
            <span>Enlarge photos smaller than this size</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="frameos-strong font-semibold">Format</span>
            <Select value={format} onChange={(value) => setFormat(value as typeof format)} options={RESIZE_FORMATS} />
          </label>
          {lossy ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="frameos-strong font-semibold">Quality: {quality}</span>
              <input
                type="range"
                min={1}
                max={100}
                value={quality}
                onChange={(event) => setQuality(Number(event.target.value))}
                className="mt-2"
              />
              <span className="frameos-muted text-xs">
                {format === 'webp' && quality >= 100 ? 'Lossless.' : 'Frames show no difference above 85.'}
              </span>
            </label>
          ) : null}
          {format === 'png' ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="frameos-strong font-semibold">Colors</span>
              <Select value={colors} onChange={setColors} options={PNG_COLOR_CHOICES} />
              <span className="frameos-muted text-xs">Fewer colors make a much smaller file.</span>
            </label>
          ) : null}
          {padsOrFlattens ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="frameos-strong font-semibold">Background</span>
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(background) ? background : '#ffffff'}
                  onChange={(event) => setBackground(event.target.value)}
                  className="h-10 w-14 cursor-pointer rounded-lg border border-white/90 bg-white/90 p-1"
                />
                <span className="frameos-muted text-xs">
                  {fit === 'contain' ? 'Fills the padding' : 'Behind transparent parts'}
                  {fit === 'contain' && format === 'jpeg' ? ' and behind transparent parts' : ''}.
                </span>
              </span>
            </label>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeResize}
            className={clsx(toolbarButtonClassName, 'frameos-secondary-button')}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || mutating}
            onClick={() => resizeEntries(resizeTargets, options)}
            className={clsx(toolbarButtonClassName, 'frameos-primary-action text-white')}
          >
            <ArrowsPointingInIcon className="h-5 w-5" />
            {count === 1 ? 'Resize' : `Resize ${count} photos`}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/** A line under the toolbar while a batch of photos is being resized. */
function ResizeProgress(): JSX.Element | null {
  const { resizeProgress } = useValues(photosLogic)
  if (!resizeProgress) {
    return null
  }
  return (
    <div className="frameos-card mb-3 flex items-center gap-3 rounded-2xl border border-white/90 bg-white/90 px-4 py-2 text-sm shadow-sm">
      <Spinner className="h-4 w-4" />
      <span>
        Resizing {Math.min(resizeProgress.done + 1, resizeProgress.total)} of {resizeProgress.total}…
      </span>
      <span className="frameos-divider ml-auto h-1.5 w-40 overflow-hidden rounded-full bg-slate-200">
        <span
          className="block h-full rounded-full bg-blue-500 transition-all"
          style={{ width: `${Math.round((resizeProgress.done / Math.max(1, resizeProgress.total)) * 100)}%` }}
        />
      </span>
    </div>
  )
}

function Notice(): JSX.Element | null {
  const { notice } = useValues(photosLogic)
  const { dismissNotice } = useActions(photosLogic)
  if (!notice) {
    return null
  }
  return (
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className={clsx(
        'mb-3 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm',
        notice.kind === 'error'
          ? 'border-red-200 bg-red-50 text-red-900'
          : 'frameos-card border-white/90 bg-white/90 text-slate-700'
      )}
    >
      {notice.kind === 'error' ? <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" /> : null}
      <span className="min-w-0 flex-1">{notice.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismissNotice}
        className="shrink-0 opacity-70 hover:opacity-100"
      >
        <XMarkIcon className="h-5 w-5" />
      </button>
    </div>
  )
}

function PhotosBrowser(): JSX.Element {
  const {
    folder,
    visibleEntries,
    folderLoaded,
    currentFolderError,
    selectedPaths,
    sharesByPath,
    viewMode,
    search,
    draggingPaths,
  } = useValues(photosLogic)
  const { handleKeyDown } = useActions(photosLogic)
  const { isOver, handlers } = useFolderDrop(folder)
  const selected = new Set(selectedPaths)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const inDialog = !!target?.closest('[role="dialog"]') && !target?.closest('.photos-lightbox')
      if (typing || inDialog) {
        return
      }
      const meta = event.metaKey || event.ctrlKey
      const keys = photosLogic.values.lightboxPath
        ? ['ArrowLeft', 'ArrowRight', 'Escape']
        : ['Escape', 'Delete', 'Backspace', 'Enter', ...(meta ? ['a'] : [])]
      if (keys.includes(event.key)) {
        event.preventDefault()
        handleKeyDown(event.key, meta)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      {...handlers}
      className={clsx(
        'photos-browser relative flex min-h-0 flex-1 flex-col rounded-[24px] border-2 border-dashed border-transparent transition',
        isOver && !draggingPaths.length && 'frameos-primary-drop-target'
      )}
    >
      <Notice />
      <ResizeProgress />
      <SelectionBar />
      <div className="@container min-h-0 flex-1 overflow-y-auto pb-24">
        {!folderLoaded && !currentFolderError ? (
          <LoadingGrid />
        ) : currentFolderError ? (
          <div className="frameos-muted flex min-h-[40vh] items-center justify-center text-sm">
            {currentFolderError}
          </div>
        ) : visibleEntries.length === 0 ? (
          search ? (
            <div className="frameos-muted flex min-h-[40vh] items-center justify-center text-sm">
              Nothing here matches "{search}".
            </div>
          ) : (
            <EmptyFolder isRoot={!folder} />
          )
        ) : viewMode === 'list' ? (
          <div className="frameos-card rounded-2xl border border-white/90 bg-white/80 p-2 shadow-sm">
            {visibleEntries.map((entry) => (
              <ListRow
                key={entry.path}
                entry={entry}
                selected={selected.has(entry.path)}
                shared={!!sharesByPath[entry.path]}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3">
            {visibleEntries.map((entry) =>
              entry.kind === 'folder' ? (
                <FolderTile
                  key={entry.path}
                  entry={entry}
                  selected={selected.has(entry.path)}
                  shared={!!sharesByPath[entry.path]}
                />
              ) : (
                <FileTile key={entry.path} entry={entry} selected={selected.has(entry.path)} />
              )
            )}
          </div>
        )}
      </div>
      {isOver && !draggingPaths.length ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
          <span className="frameos-primary-active rounded-full px-4 py-2 text-sm font-semibold text-white shadow-lg">
            Drop to upload to {folder ? photoBaseName(folder) : 'the library'}
          </span>
        </div>
      ) : null}
    </div>
  )
}

function PhotosNotReady({ status }: { status: PhotosStatus }): JSX.Element {
  const { loadStatus } = useActions(photosLogic)
  const { statusLoading } = useValues(photosLogic)
  const title =
    status.problem === 'suspended'
      ? 'Photos is turned off for this account'
      : status.problem === 'not_persistent'
      ? 'Photos needs a storage volume'
      : status.problem === 'not_writable'
      ? 'Photos cannot write its folder'
      : 'Photos is not available'
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="frameos-card max-w-lg space-y-3 rounded-[24px] border border-white/90 bg-white/90 p-6 shadow-lg">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <ExclamationTriangleIcon className="h-6 w-6" />
        </span>
        <h2 className="frameos-strong text-xl font-bold">{title}</h2>
        {status.message ? <p className="frameos-muted text-sm leading-6">{status.message}</p> : null}
        {status.location ? (
          <p className="frameos-muted text-sm">
            Folder: <code className="font-mono text-xs">{status.location}</code>
          </p>
        ) : null}
        {status.problem !== 'suspended' ? (
          <p className="frameos-muted text-sm">
            See <code className="font-mono text-xs">docs/photos.md</code> for the setup, then check again.
          </p>
        ) : null}
        <button
          type="button"
          disabled={statusLoading}
          onClick={loadStatus}
          className={clsx(toolbarButtonClassName, 'frameos-secondary-button')}
        >
          {statusLoading ? <Spinner className="h-4 w-4" /> : <ArrowPathIcon className="h-4 w-4" />}
          Check again
        </button>
      </div>
    </div>
  )
}

export function PhotosWorkspace(): JSX.Element {
  useMountedLogic(photosLogic)
  const { status } = useValues(photosLogic)

  return (
    <FrameosShell
      mode="photos"
      title="Photos"
      tree={<PhotosSidebar />}
      topBar={status?.ready ? <PhotosTopBar /> : null}
      showAiButton={false}
      mainClassName="photos-workspace-main flex h-screen flex-col overflow-hidden pb-5 pr-5 pt-5 max-lg:h-auto max-lg:min-h-screen max-lg:overflow-visible max-lg:px-4"
    >
      <>
        {!status ? <LoadingGrid /> : !status.ready ? <PhotosNotReady status={status} /> : <PhotosBrowser />}
        <UploadPanel />
        <Lightbox />
        <PhotosDialogs />
      </>
    </FrameosShell>
  )
}

export default PhotosWorkspace
