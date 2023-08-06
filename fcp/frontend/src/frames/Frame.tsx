import { A } from 'kea-router'
import { FrameType } from '../types'

interface FrameProps {
  frame: FrameType
}

export function Frame({ frame }: FrameProps): JSX.Element {
  return (
    <div
      id={`frame-${frame.id}`}
      className="w-full bg-white border border-gray-200 rounded-lg shadow dark:bg-gray-800 dark:border-gray-700"
    >
      <A href={`/frames/${frame.id}`}>
        <img className="rounded-t-lg" src={`/images/image${(frame.id % 20) + 1}.jpg`} alt="" />
      </A>
      <div className="flex justify-between px-4 pt-4 mb-2">
        <h5 className="text-3xl font-bold text-gray-900 dark:text-white">
          <A href={`/frames/${frame.id}`}>{frame.ip}</A>
        </h5>
      </div>
      <div className="px-4 pb-4">
        <p className="text-base text-gray-500 sm:text-lg dark:text-gray-400">{frame.status}</p>
      </div>
    </div>
  )
}
