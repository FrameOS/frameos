import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { framesModel } from '../../../../models/framesModel'
import { frameLogic } from '../../frameLogic'
import { useEffect, useState } from 'react'

export interface ImageProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string
}

export function Image({ className, ...props }: ImageProps) {
  const { getFrameImage, frames } = useValues(framesModel)
  const { updateFrameImage } = useActions(framesModel)
  const { frameId } = useValues(frameLogic)

  const [isLoading, setIsLoading] = useState(true)
  useEffect(() => {
    setIsLoading(true)
  }, [getFrameImage(frameId)])

  const visiblyLoading = (isLoading || frames[frameId]?.status !== 'ready') && frames[frameId]?.interval > 5

  return (
    <div
      className={clsx(
        'max-w-full max-h-full w-full h-full flex items-center justify-center',
        visiblyLoading ? 'continuous-fade-in-out' : null,
        visiblyLoading ? 'cursor-wait' : 'cursor-pointer',
        className
      )}
      onClick={() => updateFrameImage(frameId)}
      title="Click to refresh"
      {...props}
    >
      {frames[frameId] ? (
        <img
          className={clsx('rounded-lg rounded-tl-none max-w-full max-h-full')}
          src={getFrameImage(frameId)}
          onLoad={() => setIsLoading(false)}
          onError={() => setIsLoading(false)}
          style={{
            ...(frames[frameId].width && frames[frameId].height
              ? {
                  aspectRatio:
                    frames[frameId].rotate === 90 || frames[frameId].rotate === 270
                      ? `${frames[frameId].height} / ${frames[frameId].width}`
                      : `${frames[frameId].width} / ${frames[frameId].height}`,
                  maxWidth: '100%',
                  maxHeight: '100%',
                }
              : {}),
          }}
          alt=""
        />
      ) : null}
    </div>
  )
}
