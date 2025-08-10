import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { frameLogic } from './frameLogic'
import { frameHost } from '../../decorators/frame'
import { Spinner } from '../../components/Spinner'
import { Button } from '../../components/Button'
import { Header } from '../../components/Header'
import { Panels } from './panels/Panels'
import { DropdownMenu } from '../../components/DropdownMenu'
import { panelsLogic } from './panels/panelsLogic'
import { assetsLogic } from './panels/Assets/assetsLogic'
import { FrameConnection } from '../frames/Frame'
import { sdCardModalLogic } from './sdcard/sdCardModalLogic'
import { SDCardModal } from './sdcard/SDCardModal'

interface FrameSceneProps {
  id: string // taken straight from the URL, thus a string
}

export function Frame(props: FrameSceneProps) {
  const frameId = parseInt(props.id)
  const frameLogicProps = { frameId }
  const { frame, mode, unsavedChanges, undeployedChanges, requiresRecompilation } = useValues(
    frameLogic(frameLogicProps)
  )
  const {
    saveFrame,
    renderFrame,
    rebootFrame,
    restartFrame,
    stopFrame,
    deployFrame,
    fastDeployFrame,
    fullDeployFrame,
    deployAgent,
    restartAgent,
  } = useActions(frameLogic(frameLogicProps))
  const { openSDCardModal } = useActions(sdCardModalLogic(frameLogicProps))
  useMountedLogic(assetsLogic(frameLogicProps)) // Don't lose what we downloaded when navigating away from the tab
  const { openLogs } = useActions(panelsLogic(frameLogicProps))

  const canDeployAgent = frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret && mode === 'rpios'
  const canRestartAgent = frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret
  const agentExtra = canDeployAgent ? (frame?.agent?.agentRunCommands ? ' (via agent)' : ' (via ssh)') : ''
  // TODO
  const firstEverForNixOS = false && frame.mode === 'nixos' && frame.status === 'uninitialized'

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      {frame ? (
        <div className="h-full w-full max-w-screen max-h-screen overflow-hidden left-0 top-0 absolute flex flex-col">
          <Header
            title={
              !frame ? (
                `Loading frame ${props.id}...`
              ) : (
                <div className="flex items-center gap-2">
                  <span>{frame.name || frameHost(frame)}</span>
                  <FrameConnection frame={frame} />
                </div>
              )
            }
            buttons={
              <div className="flex divide-x divide-gray-700 space-x-2">
                <DropdownMenu
                  buttonColor="secondary"
                  className="items-center"
                  items={[
                    ...(mode === 'nixos' ? [{ label: 'Build SD card...', onClick: () => openSDCardModal() }] : []),
                    { label: 'Re-Render' + agentExtra, onClick: () => renderFrame() },
                    { label: 'Restart FrameOS' + agentExtra, onClick: () => restartFrame() },
                    { label: 'Stop FrameOS' + agentExtra, onClick: () => stopFrame() },
                    { label: 'Reboot device' + agentExtra, onClick: () => rebootFrame() },
                    ...(requiresRecompilation
                      ? []
                      : [
                          {
                            label: 'Fast deploy' + agentExtra,
                            onClick: () => {
                              fastDeployFrame()
                              openLogs()
                            },
                          },
                        ]),
                    {
                      label: 'Full deploy' + agentExtra,
                      onClick: () => {
                        fullDeployFrame()
                        openLogs()
                      },
                    },
                    ...(canDeployAgent
                      ? [
                          {
                            label: 'Deploy agent (via ssh)',
                            onClick: () => {
                              deployAgent()
                              openLogs()
                            },
                          },
                        ]
                      : []),
                    ...(canRestartAgent ? [{ label: 'Restart agent (via ssh)', onClick: () => restartAgent() }] : []),
                  ]}
                />
                <div className="flex pl-2 space-x-2">
                  <Button color={unsavedChanges ? 'primary' : 'secondary'} type="button" onClick={() => saveFrame()}>
                    Save
                  </Button>
                  {firstEverForNixOS ? (
                    <Button
                      color="primary"
                      type="button"
                      onClick={() => {
                        openSDCardModal()
                      }}
                    >
                      Download SD card .img
                    </Button>
                  ) : (
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
                  )}
                </div>
                <SDCardModal />
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
