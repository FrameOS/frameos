import { useValues } from 'kea'
import { framesLogic } from './framesLogic'
import { NewFrame } from './NewFrame'
import { Frame } from './Frame'

export function Frames() {
  const { frames } = useValues(framesLogic)
  return (
    <div>
      <h1 className="mb-4 text-2xl font-extrabold leading-none tracking-tight text-gray-900 md:text-3xl lg:text-4xl dark:text-white">
        FrameOS
      </h1>
      <div id="frames" className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {frames.map((frame) => (
          <Frame key={frame.id} frame={frame} />
        ))}
        <NewFrame />
      </div>
    </div>
  )
}
