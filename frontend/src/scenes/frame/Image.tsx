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
        'max-w-full max-h-full w-full h-full flex items-center justify-center',
        frames[id]?.status !== 'ready' ? 'continuous-fade-in-out' : null,
        className
      )}
    >
      {frames[id] ? (
        <img
          className="rounded-lg max-w-full max-h-full"
          src={getFrameImage(id)}
          style={{
            ...(frames[id].width && frames[id].height
              ? {
                  aspectRatio: `${frames[id].width} / ${frames[id].height}`,
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