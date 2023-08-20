import { BindLogic, useValues } from 'kea'
import { H1 } from '../../components/H1'
import { frameLogic } from './frameLogic'
import { A } from 'kea-router'
import { Logs } from './Logs'
import { Image } from '../frames/Image'
import { Details } from './Details'
import { frameHost, frameUrl } from '../../decorators/frame'
import { Box } from '../../components/Box'
import { Apps } from './Apps'

interface FrameSceneProps {
  id: string // from the URL
}

export function Frame(props: FrameSceneProps) {
  const frameLogicProps = { id: parseInt(props.id) }
  const { frame } = useValues(frameLogic(frameLogicProps))

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      <div className="space-y-4">
        <H1>
          <A href="/">FrameOS</A> <span className="text-gray-400">&raquo;</span>{' '}
          {!frame ? `Loading frame ${props.id}...` : frameHost(frame)}
        </H1>
        {frame ? (
          <>
            <Box className="m-auto max-w-max">
              <a href={frameUrl(frame)}>
                <Image id={frame.id} className="flex-1" />
              </a>
            </Box>
            <div className="flex space-x-4 items-start">
              <Details id={frame.id} className="flex-1" />
              <Apps id={frame.id} className="flex-1" />
            </div>
            <Logs id={frame.id} />
          </>
        ) : null}
      </div>
    </BindLogic>
  )
}

export default Frame
