import { useActions, useValues } from 'kea'
import { router } from 'kea-router'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { ArrowPathIcon, MagnifyingGlassPlusIcon } from '@heroicons/react/24/outline'
import { framesModel } from '../models/framesModel'
import { entityImagesModel, useEntityImage } from '../models/entityImagesModel'
import { wasmPreviewModel } from '../models/wasmPreviewModel'
import { urls } from '../urls'
import { isFrameControlMode } from '../utils/frameControlMode'
import { sceneRequiresCompilation } from '../utils/sceneApps'
import { previewSkipsNimMessage } from '../utils/sceneExecution'
import { wasmPreviewCacheKey } from '../utils/wasmScenePreview'
import type { FrameId, FrameType } from '../types'

const placeholderRefreshAttempts = new Set<string>()

function isInitialCacheOnlyImageUrl(url: string): boolean {
  if (typeof window === 'undefined') {
    return url.includes('t=-1')
  }
  try {
    return new URL(url, window.location.href).searchParams.get('t') === '-1'
  } catch {
    return url.includes('t=-1')
  }
}

function sessionRefreshAttempted(key: string): boolean {
  if (typeof window === 'undefined') {
    return placeholderRefreshAttempts.has(key)
  }

  try {
    if (window.sessionStorage.getItem(key)) {
      return true
    }
    window.sessionStorage.setItem(key, '1')
    return false
  } catch {
    if (placeholderRefreshAttempts.has(key)) {
      return true
    }
    placeholderRefreshAttempts.add(key)
    return false
  }
}

export interface FrameImageProps extends React.HTMLAttributes<HTMLDivElement> {
  frameId: FrameId
  sceneId?: string
  className?: string
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void
  /** If true, user can click on the image to request a refresh of the signed URL */
  refreshable?: boolean
  thumb?: boolean
  objectFit?: React.CSSProperties['objectFit']
  imageClassName?: string
  hideWhileLoading?: boolean
  loadFullSizeAfterThumb?: boolean
  /** Cloud and backend modes: when the image fails to load (no device
   * snapshot, no store cover), offer to render this scene in the browser via
   * the frameos-wasm worker and show the captured bitmap instead of an empty
   * box. Click-to-render only; frame-control mode never shows it. */
  wasmFallback?: { sceneId: string } | undefined
}

/**
 * Browser-rendered stand-in for a tile with no device-sourced image.
 *
 * Never renders on its own: a scene render runs the scene's data apps with
 * the account's real settings, and some of those calls cost money (an OpenAI
 * image node, for example). Rendering only happens when the user clicks the
 * tile's "Preview in browser" action — the same deliberate act as the
 * editor's preview modal — and the result is cached, so one click is one
 * render.
 */
function WasmScenePreviewFallback({
  frame,
  sceneId,
  imageClassName,
  imageStyle,
}: {
  frame: FrameType
  sceneId: string
  imageClassName: string
  imageStyle: React.CSSProperties
}): JSX.Element {
  const { scenePreviews } = useValues(wasmPreviewModel)
  const { requestScenePreview } = useActions(wasmPreviewModel)
  const [requested, setRequested] = useState(false)
  const cacheKey = wasmPreviewCacheKey(frame, sceneId)
  // Honesty first: the browser runs the interpreter, so a legacy compiled
  // scene's Nim parts are simply missing from this picture.
  const skipsNim = sceneRequiresCompilation(frame.scenes?.find((scene) => scene.id === sceneId) ?? {})
  const dataUrl = scenePreviews[cacheKey]
  // A null entry is a tombstone (failed render): show nothing, don't retry.
  const rendered = cacheKey in scenePreviews
  const pending = requested && !rendered

  return (
    <div
      className="relative flex h-full max-h-full w-full max-w-full items-center justify-center"
      title="Browser-rendered preview (device image unavailable)"
    >
      {typeof dataUrl === 'string' ? (
        <>
          <img className={imageClassName} src={dataUrl} style={imageStyle} alt="" />
          <span className="pointer-events-none absolute bottom-1 right-1 z-10 rounded bg-white/75 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-slate-500 shadow-sm backdrop-blur-sm">
            Preview
          </span>
          {skipsNim ? (
            <span
              className="pointer-events-none absolute bottom-1 left-1 z-10 max-w-[70%] truncate rounded bg-amber-100/90 px-1 py-px text-[9px] font-semibold text-amber-800 shadow-sm backdrop-blur-sm"
              title={previewSkipsNimMessage}
            >
              Nim not executed
            </span>
          ) : null}
        </>
      ) : !rendered ? (
        <button
          type="button"
          className="z-10 rounded-lg bg-white/60 px-2 py-1 text-[10px] font-medium text-slate-500 shadow-sm ring-1 ring-slate-200/70 backdrop-blur transition hover:bg-white/90 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-default disabled:opacity-60"
          disabled={pending}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setRequested(true)
            requestScenePreview(frame.id, sceneId)
          }}
        >
          {pending ? 'Rendering…' : 'Preview in browser'}
        </button>
      ) : null}
    </div>
  )
}

export function FrameImageRefreshButton({
  frameId,
  sceneId,
  className,
}: {
  frameId: FrameId
  sceneId?: string
  className?: string
}) {
  const { updateEntityImage } = useActions(entityImagesModel)
  const entityId = `frames/${frameId}`
  const subEntityId = sceneId ? `scene_images/${sceneId}` : 'image'

  return (
    <button
      type="button"
      title="Refresh image"
      aria-label="Refresh image"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        updateEntityImage(entityId, subEntityId)
      }}
      className={clsx(
        'absolute left-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg bg-white/60 text-slate-500 opacity-70 shadow-sm ring-1 ring-slate-200/70 backdrop-blur transition hover:bg-white/90 hover:text-slate-800 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        className
      )}
    >
      <ArrowPathIcon className="h-4 w-4" />
    </button>
  )
}

export function FrameImagePreviewButton({ frameId, className }: { frameId: FrameId; className?: string }) {
  return (
    <button
      type="button"
      title="Open preview"
      aria-label="Open preview"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        router.actions.push(urls.frame(frameId, 'preview'))
      }}
      className={clsx(
        'absolute bottom-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg bg-white/60 text-slate-500 opacity-70 shadow-sm ring-1 ring-slate-200/70 backdrop-blur transition hover:bg-white/90 hover:text-slate-800 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        className
      )}
    >
      <MagnifyingGlassPlusIcon className="h-4 w-4" />
    </button>
  )
}

/**
 * Consolidated Image component:
 * - Takes a frameId
 * - Uses framesModel to get and update the frame's image
 * - Shows loading states based on image load or frame readiness
 * - Optionally allows clicking the image container to refresh the image link if `refreshable` is true
 */
export function FrameImage({
  frameId,
  sceneId,
  thumb = false,
  className,
  refreshable = true,
  onClick,
  objectFit,
  imageClassName,
  hideWhileLoading = false,
  loadFullSizeAfterThumb = false,
  wasmFallback,
  ...props
}: FrameImageProps) {
  const { frames } = useValues(framesModel)
  const { refreshEntityImageMetadata, updateEntityImage } = useActions(entityImagesModel)
  const frame = frames[frameId]
  const frameAspectRatio =
    frame?.width && frame.height
      ? frame.rotate === 90 || frame.rotate === 270
        ? `${frame.height} / ${frame.width}`
        : `${frame.width} / ${frame.height}`
      : undefined

  const entityId = `frames/${frameId}`
  const subEntityId = sceneId ? `scene_images/${sceneId}` : 'image'

  const { imageUrl, isLoading, setIsLoading } = useEntityImage(entityId, subEntityId)
  const thumbImageSrc = imageUrl ? imageUrl + (imageUrl.includes('?') ? '&thumb=1' : '?thumb=1') : undefined
  const imageSrc = thumb ? thumbImageSrc : imageUrl ?? undefined
  const shouldProgressivelyLoadFullSize = Boolean(loadFullSizeAfterThumb && thumb && imageUrl)
  const [fullSizeLoadUrl, setFullSizeLoadUrl] = useState<string | null>(null)
  const [fullSizeLoadedUrl, setFullSizeLoadedUrl] = useState<string | null>(null)
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  const fullSizeLoadFrames = useRef<number[]>([])
  const shouldLoadFullSize = shouldProgressivelyLoadFullSize && fullSizeLoadUrl === imageUrl
  const fullSizeLoaded = shouldProgressivelyLoadFullSize && fullSizeLoadedUrl === imageUrl
  const baseImageFailed = !!imageSrc && failedImageUrl === imageSrc
  // Device-sourced images always win: the wasm render only fills the empty
  // box left when the image endpoint has nothing to serve. Cloud mode only.
  const wasmFallbackSceneId = wasmFallback?.sceneId
  const showWasmFallback = Boolean(wasmFallbackSceneId && baseImageFailed && frame && !isFrameControlMode())

  // Determine if we should show the fade-in-out or loading cursor
  const visiblyLoading = !sceneId && (isLoading || frame?.status !== 'ready') && frame?.interval > 5

  const cancelQueuedFullSizeLoad = () => {
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      for (const frame of fullSizeLoadFrames.current) {
        window.cancelAnimationFrame(frame)
      }
    }
    fullSizeLoadFrames.current = []
  }

  useEffect(() => {
    return cancelQueuedFullSizeLoad
  }, [])

  useEffect(() => {
    setFailedImageUrl(null)
  }, [imageSrc])

  const handleRefreshClick =
    onClick ||
    (() => {
      if (refreshable) {
        updateEntityImage(entityId, subEntityId)
      }
    })

  const imageStyle: React.CSSProperties = {
    aspectRatio: frameAspectRatio,
    objectFit,
    maxWidth: 'inherit',
    maxHeight: 'inherit',
  }
  const baseImageClassName = clsx(
    thumb ? 'rounded-sm' : 'rounded-lg',
    refreshable ? 'rounded-tl-none max-w-full max-h-full' : imageClassName ? 'max-w-full max-h-full' : 'w-full',
    hideWhileLoading && isLoading ? 'opacity-0' : null,
    hideWhileLoading ? 'transition-opacity duration-150' : null,
    imageClassName ?? className /* duplicated for inner image by default */
  )

  const queueFullSizeLoad = () => {
    if (!shouldProgressivelyLoadFullSize || shouldLoadFullSize || !imageUrl) {
      return
    }

    const nextFullSizeUrl = imageUrl
    cancelQueuedFullSizeLoad()
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setFullSizeLoadUrl(nextFullSizeUrl)
      return
    }

    const firstFrame = window.requestAnimationFrame(() => {
      fullSizeLoadFrames.current = fullSizeLoadFrames.current.filter((frame) => frame !== firstFrame)
      const secondFrame = window.requestAnimationFrame(() => {
        fullSizeLoadFrames.current = fullSizeLoadFrames.current.filter((frame) => frame !== secondFrame)
        setFullSizeLoadUrl(nextFullSizeUrl)
      })
      fullSizeLoadFrames.current.push(secondFrame)
    })
    fullSizeLoadFrames.current.push(firstFrame)
  }

  const maybeRefreshMissingInitialFrameImage = () => {
    if (sceneId || !imageSrc || !isInitialCacheOnlyImageUrl(imageSrc)) {
      return
    }

    const refreshAttemptKey = `frameos:placeholder-image-refresh:${entityId}/${subEntityId}`
    if (sessionRefreshAttempted(refreshAttemptKey)) {
      return
    }

    void fetch(imageSrc, { method: 'HEAD', cache: 'no-store' })
      .then((response) => {
        if (response.ok && response.headers.get('x-frameos-image-state') === 'placeholder') {
          updateEntityImage(entityId, subEntityId)
        }
      })
      .catch(() => undefined)
  }

  const handleBaseImageLoad = () => {
    setIsLoading(false)
    queueFullSizeLoad()
    maybeRefreshMissingInitialFrameImage()
    refreshEntityImageMetadata(entityId, subEntityId, imageSrc)
  }

  return (
    <div
      className={clsx(
        className?.includes('max-w-') || className?.includes('max-h-') ? '' : 'max-w-full max-h-full w-full h-full',
        'flex items-center justify-center',
        shouldProgressivelyLoadFullSize ? 'relative overflow-hidden' : null,
        visiblyLoading ? 'continuous-fade-in-out' : null,
        visiblyLoading ? 'cursor-wait' : refreshable ? 'cursor-pointer' : 'cursor-default',
        className
      )}
      onClick={handleRefreshClick}
      title={refreshable ? 'Click to refresh' : undefined}
      {...props}
    >
      {frame && (
        <>
          {imageSrc && !baseImageFailed ? (
            <img
              className={baseImageClassName}
              src={imageSrc}
              onLoad={handleBaseImageLoad}
              onError={() => {
                setIsLoading(false)
                setFailedImageUrl(imageSrc)
              }}
              style={imageStyle}
              alt=""
            />
          ) : null}
          {showWasmFallback && wasmFallbackSceneId ? (
            <WasmScenePreviewFallback
              frame={frame}
              sceneId={wasmFallbackSceneId}
              imageClassName={baseImageClassName}
              imageStyle={imageStyle}
            />
          ) : null}
          {shouldProgressivelyLoadFullSize && shouldLoadFullSize ? (
            <img
              className={clsx(
                baseImageClassName,
                'absolute inset-0 transition-opacity duration-200',
                fullSizeLoaded ? 'opacity-100' : 'opacity-0'
              )}
              src={imageUrl ?? undefined}
              onLoad={() => setFullSizeLoadedUrl(imageUrl ?? null)}
              style={imageStyle}
              alt=""
            />
          ) : null}
        </>
      )}
    </div>
  )
}
