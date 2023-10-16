import { useValues } from 'kea'
import clsx from 'clsx'
import { framesModel } from '../../../../models/framesModel'
import { frameLogic } from '../../frameLogic'

export interface ImageProps {
  className?: string
}

export function Image({ className }: ImageProps) {
  const { getFrameImage, frames } = useValues(framesModel)
  const { id } = useValues(frameLogic)
  return (
    <div
      className={clsx(
        'max-w-full max-h-full w-full h-full flex items-center justify-center',
        frames[id]?.status !== 'ready' && frames[id]?.interval > 5 ? 'continuous-fade-in-out' : null,
        className
      )}
    >
      {frames[id] ? (
        <img
          className="rounded-lg rounded-tl-none max-w-full max-h-full"
          src={getFrameImage(id)}
          style={{
            ...(frames[id].width && frames[id].height
              ? {
                  aspectRatio:
                    frames[id].rotate === 90 || frames[id].rotate === 270
                      ? `${frames[id].height} / ${frames[id].width}`
                      : `${frames[id].width} / ${frames[id].height}`,
                  maxWidth: '100%',
                  maxHeight: '100%',
                  // width: frames[id].width,
                  // height: 'auto',
                }
              : {}),
          }}
          alt=""
        />
      ) : null}
    </div>
  )
}
