import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { framesModel } from '../models/framesModel'
import { useEffect, useState } from 'react'

export interface FrameImageProps extends React.HTMLAttributes<HTMLDivElement> {
  frameId: number
  className?: string
  /** If true, user can click on the image to request a refresh of the signed URL */
  refreshable?: boolean
}

/**
 * Consolidated Image component:
 * - Takes a frameId
 * - Uses framesModel to get and update the frame's image
 * - Shows loading states based on image load or frame readiness
 * - Optionally allows clicking the image container to refresh the image link if `refreshable` is true
 */
export function FrameImage({ frameId, className, refreshable = true, ...props }: FrameImageProps) {
  const { getFrameImage, frames } = useValues(framesModel)
  const { updateFrameImage } = useActions(framesModel)

  const [isLoading, setIsLoading] = useState(true)

  const imageUrl = getFrameImage(frameId)
  const frame = frames[frameId]

  useEffect(() => {
    updateFrameImage(frameId, false)
  }, [!!imageUrl])

  useEffect(() => {
    // Whenever the image URL changes, we consider the image as loading again
    // because the <img> will re-attempt to load the new URL.
    if (imageUrl) {
      setIsLoading(true)
    }
  }, [imageUrl])

  // Determine if we should show the fade-in-out or loading cursor
  const visiblyLoading = (isLoading || frame?.status !== 'ready') && frame?.interval > 5

  const handleRefreshClick = () => {
    if (refreshable) {
      updateFrameImage(frameId)
    }
  }

  return (
    <div
      className={clsx(
        'max-w-full max-h-full w-full h-full flex items-center justify-center',
        visiblyLoading ? 'continuous-fade-in-out' : null,
        visiblyLoading ? 'cursor-wait' : refreshable ? 'cursor-pointer' : 'cursor-default',
        className
      )}
      onClick={handleRefreshClick}
      title={refreshable ? 'Click to refresh' : undefined}
      {...props}
    >
      {frame && (
        <img
          className={clsx('rounded-lg', refreshable ? 'rounded-tl-none max-w-full max-h-full' : 'w-full')}
          src={imageUrl ?? undefined}
          onLoad={() => setIsLoading(false)}
          onError={() => setIsLoading(false)}
          style={{
            ...(frame.width && frame.height
              ? {
                  aspectRatio:
                    frame.rotate === 90 || frame.rotate === 270
                      ? `${frame.height} / ${frame.width}`
                      : `${frame.width} / ${frame.height}`,
                  maxWidth: '100%',
                  maxHeight: '100%',
                  // If you need a fixed width/height based on rotation:
                  // width: frame.rotate === 90 || frame.rotate === 270 ? frame.height : frame.width,
                  // height: 'auto',
                }
              : {}),
          }}
          alt=""
        />
      )}
    </div>
  )
}