import { useActions, useValues } from 'kea'
import { router } from 'kea-router'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { ArrowPathIcon, MagnifyingGlassPlusIcon } from '@heroicons/react/24/outline'
import { framesModel } from '../models/framesModel'
import { entityImagesModel, useEntityImage } from '../models/entityImagesModel'
import { urls } from '../urls'

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
  frameId: number
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
}

export function FrameImageRefreshButton({
  frameId,
  sceneId,
  className,
}: {
  frameId: number
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

export function FrameImagePreviewButton({ frameId, className }: { frameId: number; className?: string }) {
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
