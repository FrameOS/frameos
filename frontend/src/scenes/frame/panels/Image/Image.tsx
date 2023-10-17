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
  const { id } = useValues(frameLogic)

  const [isLoading, setIsLoading] = useState(true)
  useEffect(() => {
    setIsLoading(true)
  }, [getFrameImage(id)])

  const visiblyLoading = (isLoading || frames[id]?.status !== 'ready') && frames[id]?.interval > 5

  return (
    <div
      className={clsx(
        'max-w-full max-h-full w-full h-full flex items-center justify-center',
        visiblyLoading ? 'continuous-fade-in-out' : null,
        visiblyLoading ? 'cursor-wait' : 'cursor-pointer',
        className
      )}
      onClick={() => updateFrameImage(id)}
      title="Click to refresh"
      {...props}
    >
      {frames[id] ? (
        <img
          className={clsx('rounded-lg rounded-tl-none max-w-full max-h-full')}
          src={getFrameImage(id)}
          onLoad={() => setIsLoading(false)}
          onError={() => setIsLoading(false)}
          style={{
            ...(frames[id].width && frames[id].height
              ? {
                  aspectRatio:
                    frames[id].rotate === 90 || frames[id].rotate === 270
                      ? `${frames[id].height} / ${frames[id].width}`
                      : `${frames[id].width} / ${frames[id].height}`,
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
