import { useValues } from 'kea'
import { H1 } from '../../components/H1'
import { frameLogic } from './frameLogic'
import { A } from 'kea-router'

interface FrameSceneProps {
  id: string // from the URL
}

export function Frame(props: FrameSceneProps) {
  const logicProps = { id: parseInt(props.id) }
  const { frame, frameLoading } = useValues(frameLogic(logicProps))

  return (
    <div>
      <H1>
        <A href="/">FrameOS</A> <span className="text-gray-400">&raquo;</span> {frameLoading ? '...' : frame.ip}
      </H1>
    </div>
  )
}

export default Frame
