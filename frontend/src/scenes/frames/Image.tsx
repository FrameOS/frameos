import { useValues } from 'kea'
import { Box } from '../../components/Box'
import { frameLogic } from '../frame/logsLogic'
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
      className={clsx('p-2 m-auto', frames[id]?.status === 'refreshing' ? 'continuous-fade-in-out' : null, className)}
    >
      {frames[id] ? (
        <img
          className="rounded-lg w-full"
          src={getFrameImage(id)}
          style={
            frames[id].width && frames[id].height ? { aspectRatio: `${frames[id].width} / ${frames[id].height}` } : {}
          }
          alt=""
        />
      ) : null}
    </div>
  )
}
