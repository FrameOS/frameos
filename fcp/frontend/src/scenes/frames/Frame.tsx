import { A } from 'kea-router'
import { FrameType } from '../../types'
import { H5 } from '../../components/H5'
import { Box } from '../../components/Box'

interface FrameProps {
  frame: FrameType
}

export function Frame({ frame }: FrameProps): JSX.Element {
  return (
    <Box id={`frame-${frame.id}`}>
      <A href={`/frames/${frame.id}`}>
        <img className="rounded-t-lg" src={`/images/image${(frame.id % 20) + 1}.jpg`} alt="" />
      </A>
      <div className="flex justify-between px-4 pt-4 mb-2">
        <H5 className="text-ellipsis overflow-hidden">
          <A href={`/frames/${frame.id}`}>{frame.ip}</A>
        </H5>
      </div>
      <div className="px-4 pb-4">
        <p className="text-base sm:text-lg text-gray-400">{frame.status}</p>
      </div>
    </Box>
  )
}
