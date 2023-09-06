import { useValues } from 'kea'
import clsx from 'clsx'
import { framesModel } from '../../models/framesModel'

export interface ImageProps {
  id: number
  className?: string
}

export function Image({ id, className }: ImageProps) {
  const { getFrameImage, frames } = useValues(framesModel)
  return (
    <div
      className={clsx(
        'p-2 m-auto',
        frames[id]?.status !== 'ready' && frames[id]?.interval > 5 ? 'continuous-fade-in-out' : null,
        className
      )}
    >
      {frames[id] ? (
        <img
          className="rounded-lg w-full"
          src={getFrameImage(id)}
          style={{
            ...(frames[id].width && frames[id].height
              ? {
                  aspectRatio:
                    frames[id].rotate === 90 || frames[id].rotate === 270
                      ? `${frames[id].height} / ${frames[id].width}`
                      : `${frames[id].width} / ${frames[id].height}`,
                  width: frames[id].rotate === 90 || frames[id].rotate === 270 ? frames[id].height : frames[id].width,
                  maxWidth: '100%',
                  height: 'auto',
                }
              : {}),
          }}
          alt=""
        />
      ) : null}
    </div>
  )
}
