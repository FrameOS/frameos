import { A } from 'kea-router'
import { FrameType } from '../../types'
import { H5 } from '../../components/H5'

interface FrameProps {
  frame: FrameType
}

export function Frame({ frame }: FrameProps): JSX.Element {
  return (
    <div id={`frame-${frame.id}`} className="w-full border rounded-lg shadow bg-gray-800 border-gray-700">
      <A href={`/frames/${frame.id}`}>
        <img className="rounded-t-lg" src={`/images/image${(frame.id % 20) + 1}.jpg`} alt="" />
      </A>
      <div className="flex justify-between px-4 pt-4 mb-2">
        <H5>
          <A href={`/frames/${frame.id}`}>{frame.ip}</A>
        </H5>
      </div>
      <div className="px-4 pb-4">
        <p className="text-base sm:text-lg text-gray-400">{frame.status}</p>
      </div>
    </div>
  )
}
