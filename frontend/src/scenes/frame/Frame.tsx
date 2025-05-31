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
  const { frame, unsavedChanges, undeployedChanges, requiresRecompilation } = useValues(frameLogic(frameLogicProps))
  const {
    saveFrame,
    renderFrame,
    rebootFrame,
    restartFrame,
    stopFrame,
    deployFrame,
    fullDeployFrame,
    deployAgent,
    restartAgent,
  } = useActions(frameLogic(frameLogicProps))
  const { openLogs } = useActions(panelsLogic(frameLogicProps))
  const canDeployAgent = !!(frame.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret)
  const agentExtra = canDeployAgent && frame.agent?.agentRunCommands ? ' (via agent)' : ' (via ssh)'

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
                    { label: 'Re-Render' + agentExtra, onClick: () => renderFrame() },
                    { label: 'Restart FrameOS' + agentExtra, onClick: () => restartFrame() },
                    { label: 'Stop FrameOS' + agentExtra, onClick: () => stopFrame() },
                    { label: 'Reboot device' + agentExtra, onClick: () => rebootFrame() },
                    ...(!requiresRecompilation
                      ? [
                          {
                            label: 'Full deploy',
                            onClick: () => {
                              fullDeployFrame()
                              openLogs()
                            },
                          },
                        ]
                      : []),
                    ...(canDeployAgent
                      ? [
                          {
                            label: 'Deploy agent (via ssh)',
                            onClick: () => {
                              deployAgent()
                              openLogs()
                            },
                          },
                          { label: 'Restart agent (via ssh)', onClick: () => restartAgent() },
                        ]
                      : []),
                  ]}
                />
                <div className="flex pl-2 space-x-2">
                  <Button color={unsavedChanges ? 'primary' : 'secondary'} type="button" onClick={() => saveFrame()}>
                    Save
                  </Button>
                  <Button
                    color={undeployedChanges ? 'primary' : 'secondary'}
                    type="button"
                    onClick={() => {
                      deployFrame()
                      openLogs()
                    }}
                  >
                    {requiresRecompilation ? 'Full ' : 'Fast '}
                    deploy
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
