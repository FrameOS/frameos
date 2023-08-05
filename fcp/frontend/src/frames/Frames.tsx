import { useValues } from 'kea'
import { framesLogic } from './framesLogic'
import { NewFrame } from './NewFrame'
import { Frame } from './Frame'

export function Frames() {
  const { frames } = useValues(framesLogic)
  return (
    <div>
      <h1>FrameOS Control Panel</h1>
      {frames.map((frame) => (
        <Frame key={frame.id} frame={frame} />
      ))}
      {frames.length === 0 ? <div>You have no frames</div> : null}
      <NewFrame />
    </div>
  )
}
