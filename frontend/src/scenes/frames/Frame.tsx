import { A } from 'kea-router'
import { FrameType } from '../../types'
import { H5 } from '../../components/H5'
import { Box } from '../../components/Box'
import { frameHost, frameStatus } from '../../decorators/frame'
import { Image } from './Image'

interface FrameProps {
  frame: FrameType
}

export function Frame({ frame }: FrameProps): JSX.Element {
  return (
    <Box id={`frame-${frame.id}`}>
      <A href={`/frames/${frame.id}`}>
        <Image id={frame.id} />
      </A>
      <div className="flex justify-between px-4 pt-2 mb-2">
        <H5 className="text-ellipsis overflow-hidden">
          <A href={`/frames/${frame.id}`}>{frameHost(frame)}</A>
        </H5>
      </div>
      <div className="px-4 pb-4">
        <div className="flex sm:text-lg text-gray-400 items-center">{frameStatus(frame)}</div>
      </div>
    </Box>
  )
}
