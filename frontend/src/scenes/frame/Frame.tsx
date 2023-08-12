import { BindLogic, useValues } from 'kea'
import { H1 } from '../../components/H1'
import { frameLogic } from './frameLogic'
import { A } from 'kea-router'
import { Logs } from './Logs'
import { Image } from '../frames/Image'
import { Details } from './Details'
import { frameHost } from '../../decorators/frame'
import { framesModel } from '../../models/framesModel'

interface FrameSceneProps {
  id: string // from the URL
}

export function Frame(props: FrameSceneProps) {
  const { frame } = useValues(frameLogic({ id: parseInt(props.id) }))

  return (
    <div className="space-y-4">
      <H1>
        <A href="/">FrameOS</A> <span className="text-gray-400">&raquo;</span>{' '}
        {!frame ? `Loading frame ${props.id}...` : frameHost(frame)}
      </H1>
      {frame ? (
        <>
          <div className="flex gap-4 flex-col md:flex-row">
            <Details id={frame.id} className="flex-1 min-w-max" />
            <Image id={frame.id} className="flex-0" />
          </div>
          <Logs id={frame.id} />
        </>
      ) : null}
    </div>
  )
}

export default Frame
