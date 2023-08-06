import { useValues } from 'kea'
import { H1 } from '../../components/H1'
import { frameLogic } from './frameLogic'
import { A } from 'kea-router'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'

interface FrameSceneProps {
  id: string // from the URL
}

export function Frame(props: FrameSceneProps) {
  const logicProps = { id: parseInt(props.id) }
  const { frame, frameLoading } = useValues(frameLogic(logicProps))

  return (
    <div className="space-y-4">
      <H1>
        <A href="/">FrameOS</A> <span className="text-gray-400">&raquo;</span> {frameLoading ? '...' : frame.ip}
      </H1>
      {frame ? (
        <>
          <Box className="text-center">
            <img className="rounded-t-lg" src={`/images/image${(frame.id % 20) + 1}.jpg`} alt="" />
          </Box>
          <Box className="p-4">
            <H6>SSH Logs</H6>
          </Box>
        </>
      ) : null}
    </div>
  )
}

export default Frame
