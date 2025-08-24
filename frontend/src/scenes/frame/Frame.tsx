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
import { terminalLogic } from './panels/Terminal/terminalLogic'
import { Switch } from '../../components/Switch'
import { Form } from 'kea-forms'
import { Field } from '../../components/Field'

interface FrameSceneProps {
  id: string // taken straight from the URL, thus a string
}

export function Frame(props: FrameSceneProps) {
  const frameId = parseInt(props.id)
  const frameLogicProps = { frameId }
  const { frame, mode, unsavedChanges, undeployedChanges, requiresRecompilation, deployWithAgent } = useValues(
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
    setDeployWithAgent,
  } = useActions(frameLogic(frameLogicProps))
  const { openSDCardModal } = useActions(sdCardModalLogic(frameLogicProps))
  useMountedLogic(assetsLogic(frameLogicProps)) // Don't lose what we downloaded when navigating away from the tab
  useMountedLogic(terminalLogic(frameLogicProps))
  const { openLogs } = useActions(panelsLogic(frameLogicProps))

  const canDeployAgent = frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret && mode === 'rpios'
  const canRestartAgent = frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret
  const canAgentRunCommands =
    frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret && frame.agent.agentRunCommands
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
                    { label: 'Re-Render', onClick: () => renderFrame() },
                    { label: 'Restart FrameOS', onClick: () => restartFrame() },
                    { label: 'Stop FrameOS', onClick: () => stopFrame() },
                    { label: 'Reboot device', onClick: () => rebootFrame() },
                    ...(requiresRecompilation
                      ? []
                      : [
                          {
                            label: 'Fast deploy',
                            onClick: () => {
                              fastDeployFrame()
                              openLogs()
                            },
                          },
                        ]),
                    {
                      label: 'Full deploy',
                      onClick: () => {
                        fullDeployFrame()
                        openLogs()
                      },
                    },
                    ...(canRestartAgent ? [{ label: 'Restart agent', onClick: () => restartAgent() }] : []),
                    ...(canDeployAgent
                      ? [
                          {
                            label: 'Deploy agent',
                            onClick: () => {
                              deployAgent()
                              openLogs()
                            },
                          },
                        ]
                      : []),
                    ...(canAgentRunCommands
                      ? [
                          {
                            label: <div className="border-t border-white w-full" />,
                          },
                          {
                            label: (
                              <Form formKey="frameForm" logic={frameLogic} props={{ frameId }} enableFormOnSubmit>
                                <Field name={['agent', 'deployWithAgent']}>
                                  {() => (
                                    <Switch
                                      leftLabel={<>Use: {!deployWithAgent ? <u>SSH</u> : 'SSH'}</>}
                                      label={
                                        <span className={'flex gap-1'}>
                                          {deployWithAgent ? <u>Agent</u> : 'Agent'} <FrameConnection frame={frame} />
                                        </span>
                                      }
                                      alwaysActive
                                      value={deployWithAgent}
                                      onChange={setDeployWithAgent}
                                    />
                                  )}
                                </Field>
                              </Form>
                            ),
                          },
                        ]
                      : []),
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
