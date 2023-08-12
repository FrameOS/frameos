import { useValues } from 'kea'
import { NewFrame } from './NewFrame'
import { Frame } from './Frame'
import { H1 } from '../../components/H1'
import { framesModel } from '../../models/framesModel'

export function Frames() {
  const { framesList } = useValues(framesModel)
  return (
    <div>
      <H1>FrameOS</H1>
      <div id="frames" className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {framesList.map((frame) => (
          <Frame key={frame.id} frame={frame} />
        ))}
        <NewFrame />
      </div>
    </div>
  )
}

export default Frames