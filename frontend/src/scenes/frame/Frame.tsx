import { BindLogic, useValues } from 'kea'
import { H1 } from '../../components/H1'
import { frameLogic } from './frameLogic'
import { A } from 'kea-router'
import { Logs } from './Logs'
import { Image } from '../frames/Image'
import { Details } from './Details'
import { frameHost } from '../../decorators/frame'
import { Box } from '../../components/Box'

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
          <Box className="m-auto max-w-max">
            <Image id={frame.id} className="flex-1" />
          </Box>
          <Details id={frame.id} className="flex-1" />
          <Logs id={frame.id} />
        </>
      ) : null}
    </div>
  )
}

export default Frame
