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
      <a href={`/frames/${frame.id}`}>
        <img className="rounded-t-lg" src={`/images/image${(frame.id % 20) + 1}.jpg`} alt="" />
      </a>
      <div className="flex justify-between px-4 pt-4 mb-2">
        <h5 className="text-3xl font-bold text-gray-900 dark:text-white">{frame.ip}</h5>
      </div>
      <div className="px-4 pb-4">
        <p className="mb-5 text-base text-gray-500 sm:text-lg dark:text-gray-400">{frame.status}</p>
        {frame.status === 'uninitialized' ? (
          <div className="items-center justify-center space-y-4 sm:flex sm:space-y-0 sm:space-x-4">
            <a
              href="#"
              className="inline-flex items-center px-3 py-2 text-sm font-medium text-center text-white bg-blue-700 rounded-lg hover:bg-blue-800 focus:ring-4 focus:outline-none focus:ring-blue-300 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800"
            >
              Initialize
            </a>
          </div>
        ) : null}
      </div>
    </div>
  )
}
