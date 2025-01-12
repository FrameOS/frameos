import { BindLogic, useActions, useValues } from 'kea'
import { frameLogic } from './frameLogic'
import { frameHost } from '../../decorators/frame'
import { Spinner } from '../../components/Spinner'
import { Button } from '../../components/Button'
import { Header } from '../../components/Header'
import { Panels } from './panels/Panels'
import { DropdownMenu } from '../../components/DropdownMenu'
import { panelsLogic } from './panels/panelsLogic'

interface FrameSceneProps {
  id: string // taken straight from the URL, thus a string
}

export function Frame(props: FrameSceneProps) {
  const frameId = parseInt(props.id)
  const frameLogicProps = { frameId }
  const { frame, frameChanged } = useValues(frameLogic(frameLogicProps))
  const { saveFrame, renderFrame, restartFrame, stopFrame, deployFrame } = useActions(frameLogic(frameLogicProps))
  const { openLogs } = useActions(panelsLogic(frameLogicProps))

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      {frame ? (
        <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute flex flex-col">
          <Header
            title={!frame ? `Loading frame ${props.id}...` : frame.name || frameHost(frame)}
            buttons={
              <div className="flex divide-x divide-gray-700 space-x-2">
                <DropdownMenu
                  buttonColor="secondary"
                  className="items-center"
                  items={[
                    { label: 'Re-Render', onClick: () => renderFrame() },
                    { label: 'Restart', onClick: () => restartFrame() },
                    { label: 'Stop', onClick: () => stopFrame() },
                  ]}
                />
                <div className="flex pl-2 space-x-2">
                  <Button color={frameChanged ? 'primary' : 'secondary'} type="button" onClick={() => saveFrame()}>
                    Save
                  </Button>
                  <Button
                    color={'secondary'}
                    type="button"
                    onClick={() => {
                      deployFrame()
                      openLogs()
                    }}
                  >
                    Redeploy
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
