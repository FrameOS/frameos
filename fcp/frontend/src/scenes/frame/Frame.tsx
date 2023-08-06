import { BindLogic, useValues } from 'kea'
import { H1 } from '../../components/H1'
import { frameLogic } from './frameLogic'
import { A } from 'kea-router'
import { Logs } from './Logs'
import { Image } from './Image'
import { Details } from './Details'

interface FrameSceneProps {
  id: string // from the URL
}

export function Frame(props: FrameSceneProps) {
  const logicProps = { id: parseInt(props.id) }
  const { frame, frameLoading } = useValues(frameLogic(logicProps))

  return (
    <BindLogic logic={frameLogic} props={logicProps}>
      <div className="space-y-4">
        <H1>
          <A href="/">FrameOS</A> <span className="text-gray-400">&raquo;</span> {frameLoading ? '...' : frame.ip}
        </H1>
        {frame ? (
          <>
            <div className="flex gap-4">
              <Details className="flex-1" />
              <Image className="flex-0" />
            </div>
            <Logs />
          </>
        ) : null}
      </div>
    </BindLogic>
  )
}

export default Frame
