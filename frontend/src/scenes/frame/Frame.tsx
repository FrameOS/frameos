import { BindLogic, useActions, useValues } from 'kea'
import { frameLogic } from './frameLogic'
import { frameHost } from '../../decorators/frame'
import { Spinner } from '../../components/Spinner'
import { Button } from '../../components/Button'
import { Header } from '../../components/Header'
import { Panels } from './panels/Panels'

interface FrameSceneProps {
  id: string // taken straight from the URL, thus a string
}

export function Frame(props: FrameSceneProps) {
  const frameId = parseInt(props.id)
  const frameLogicProps = { frameId }
  const { frame, frameChanged } = useValues(frameLogic(frameLogicProps))
  const { saveFrame, renderFrame, restartFrame, stopFrame, deployFrame } = useActions(frameLogic(frameLogicProps))

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      {frame ? (
        <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute flex flex-col">
          <Header
            title={!frame ? `Loading frame ${props.id}...` : frame.name || frameHost(frame)}
            buttons={
              <div className="flex divide-x divide-gray-700 space-x-2">
                <Button color="light-gray" type="button" onClick={() => renderFrame()}>
                  Re-Render
                </Button>
                <Button color="light-gray" type="button" onClick={() => restartFrame()}>
                  Restart
                </Button>
                <Button color="light-gray" type="button" onClick={() => stopFrame()}>
                  Stop
                </Button>
                <div className="flex pl-2 space-x-2">
                  <Button color={frameChanged ? 'primary' : 'light-gray'} type="button" onClick={() => saveFrame()}>
                    Save
                  </Button>
                  <Button color={frameChanged ? 'primary' : 'light-gray'} type="button" onClick={() => deployFrame()}>
                    Save&nbsp;&&nbsp;Redeploy
                  </Button>
                </div>
              </div>
            }
          />
          <Panels />
        </div>
      ) : (
        <div>
          Loading frame {props.id} <Spinner />
        </div>
      )}
    </BindLogic>
  )
}

export default Frame
