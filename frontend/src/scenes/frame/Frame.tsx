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
  const id = parseInt(props.id)
  const frameLogicProps = { id }
  const { frame, frameChanged } = useValues(frameLogic(frameLogicProps))
  const { saveFrame, renderFrame, restartFrame, deployFrame } = useActions(frameLogic(frameLogicProps))

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      {frame ? (
        <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute flex flex-col">
          <Header
            title={!frame ? `Loading frame ${props.id}...` : frame.name || frameHost(frame)}
            buttons={
              <div className="flex divide-x divide-gray-700 space-x-2">
                <Button
                  color="light-gray"
                  type="button"
                  onClick={() => renderFrame()}
                  title="Refresh the frame with its _old_ config. Save any unsaved changes, but don't apply them."
                >
                  Re-Render
                </Button>
                <div className="flex pl-2 space-x-2">
                  <Button color={frameChanged ? 'primary' : 'light-gray'} type="button" onClick={() => saveFrame()}>
                    Save
                  </Button>
                  <Button
                    color="light-gray"
                    type="button"
                    onClick={() => restartFrame()}
                    title="Restart the frame with the new config."
                  >
                    Save&nbsp;&&nbsp;Restart
                  </Button>
                  <Button
                    color="light-gray"
                    type="button"
                    onClick={() => deployFrame()}
                    title="Deploy FrameOS onto the frame."
                  >
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
