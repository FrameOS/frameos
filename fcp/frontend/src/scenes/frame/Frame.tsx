import { useValues } from 'kea'
import { H1 } from '../../components/H1'
import { frameLogic } from './frameLogic'
import { A } from 'kea-router'

interface FrameSceneProps {
  id: string // from the URL
}

export function Frame(props: FrameSceneProps) {
  const logicProps = { id: parseInt(props.id) }
  const { id } = useValues(frameLogic(logicProps))

  return (
    <div>
      <H1>
        <A href="/">FrameOS</A> &raquo; Frame {id}
      </H1>
    </div>
  )
}

export default Frame
