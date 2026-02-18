import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { frameLogic } from './frameLogic'
import { frameHost } from '../../decorators/frame'
import { Spinner } from '../../components/Spinner'
import { Button } from '../../components/Button'
import { Header } from '../../components/Header'
import { Panels } from './panels/Panels'
import { DropdownMenu } from '../../components/DropdownMenu'
import { panelsLogic } from './panels/panelsLogic'
import { luckfoxBuildrootPlatformValues } from '../../devices'
import { assetsLogic } from './panels/Assets/assetsLogic'
import { FrameConnection } from '../frames/Frame'
import { sdCardModalLogic } from './sdcard/sdCardModalLogic'
import { SDCardModal } from './sdcard/SDCardModal'
import { terminalLogic } from './panels/Terminal/terminalLogic'
import { Switch } from '../../components/Switch'
import { Form } from 'kea-forms'
import { Field } from '../../components/Field'
import { frameSettingsLogic } from './panels/FrameSettings/frameSettingsLogic'
import { logsLogic } from './panels/Logs/logsLogic'
import { Popover, Transition } from '@headlessui/react'

interface FrameSceneProps {
  id: string // taken straight from the URL, thus a string
}

export function Frame(props: FrameSceneProps) {
  const frameId = parseInt(props.id)
  const frameLogicProps = { frameId }
  const {
    frame,
    mode,
    unsavedChanges,
    undeployedChanges,
    requiresRecompilation,
    deployWithAgent,
    unsavedChangeDetails,
    undeployedChangeDetails,
  } = useValues(frameLogic(frameLogicProps))
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
    resetUnsavedChanges,
    resetUndeployedChanges,
  } = useActions(frameLogic(frameLogicProps))
  const { openSDCardModal } = useActions(sdCardModalLogic(frameLogicProps))
  useMountedLogic(assetsLogic(frameLogicProps)) // Don't lose what we downloaded when navigating away from the tab
  useMountedLogic(terminalLogic(frameLogicProps))
  useMountedLogic(frameSettingsLogic(frameLogicProps))
  useMountedLogic(logsLogic(frameLogicProps))
  const { openLogs } = useActions(panelsLogic(frameLogicProps))

  const canDeployAgent = frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret && mode === 'rpios'
  const canRestartAgent = frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret
  const canAgentRunCommands =
    frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret && frame.agent.agentRunCommands
  // TODO
  const firstEverForNixOS = false && frame.mode === 'nixos' && frame.status === 'uninitialized'
  const canBuildSdImage = mode === 'nixos' || mode === 'buildroot'

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
                {unsavedChanges ? (
                  <Popover className="relative pr-2 text-[#9a9ad0] flex items-center">
                    {({ open }) => (
                      <>
                        <Popover.Button className="underline underline-offset-2">
                          Unsaved changes{requiresRecompilation ? ', requires full deploy!' : ''}
                        </Popover.Button>
                        <Transition
                          show={open}
                          enter="transition ease-out duration-100"
                          enterFrom="transform opacity-0 scale-95"
                          enterTo="transform opacity-100 scale-100"
                          leave="transition ease-in duration-75"
                          leaveFrom="transform opacity-100 scale-100"
                          leaveTo="transform opacity-0 scale-95"
                        >
                          <Popover.Panel className="absolute right-0 top-7 z-50 min-w-96 max-w-[38rem] rounded-md border border-gray-700 bg-gray-900 p-3 shadow-lg">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <div className="text-xs text-gray-300">Unsaved changes</div>
                              <Button
                                color="secondary"
                                size="small"
                                type="button"
                                onClick={() => resetUnsavedChanges()}
                              >
                                Reset changes
                              </Button>
                            </div>
                            <ul className="space-y-1 text-sm text-gray-100">
                              {unsavedChangeDetails.map((change, index) => (
                                <li
                                  key={`${change.label}-${index}`}
                                  className="flex items-center justify-between gap-3"
                                >
                                  <span>{change.label}</span>
                                  {change.requiresFullDeploy ? (
                                    <span className="rounded bg-purple-700/40 px-2 py-0.5 text-[11px] text-purple-100">
                                      Full deploy
                                    </span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </Popover.Panel>
                        </Transition>
                      </>
                    )}
                  </Popover>
                ) : undeployedChanges ? (
                  <Popover className="relative pr-2 text-[#9a9ad0] flex items-center">
                    {({ open }) => (
                      <>
                        <Popover.Button className="underline underline-offset-2">Undeployed changes</Popover.Button>
                        <Transition
                          show={open}
                          enter="transition ease-out duration-100"
                          enterFrom="transform opacity-0 scale-95"
                          enterTo="transform opacity-100 scale-100"
                          leave="transition ease-in duration-75"
                          leaveFrom="transform opacity-100 scale-100"
                          leaveTo="transform opacity-0 scale-95"
                        >
                          <Popover.Panel className="absolute right-0 top-7 z-50 min-w-96 max-w-[38rem] rounded-md border border-gray-700 bg-gray-900 p-3 shadow-lg">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <div className="text-xs text-gray-300">Not yet deployed</div>
                              <Button
                                color="secondary"
                                size="small"
                                type="button"
                                onClick={() => resetUndeployedChanges()}
                              >
                                Reset changes
                              </Button>
                            </div>
                            <ul className="space-y-1 text-sm text-gray-100">
                              {undeployedChangeDetails.map((change, index) => (
                                <li
                                  key={`${change.label}-${index}`}
                                  className="flex items-center justify-between gap-3"
                                >
                                  <span>{change.label}</span>
                                  {change.requiresFullDeploy ? (
                                    <span className="rounded bg-purple-700/40 px-2 py-0.5 text-[11px] text-purple-100">
                                      Full deploy
                                    </span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </Popover.Panel>
                        </Transition>
                      </>
                    )}
                  </Popover>
                ) : null}

                <DropdownMenu
                  buttonColor="secondary"
                  className="items-center"
                  items={[
                    ...(canBuildSdImage ? [{ label: 'Build SD card...', onClick: () => openSDCardModal() }] : []),
                    { label: 'Re-Render', onClick: () => renderFrame() },
                    { label: 'Restart FrameOS', onClick: () => restartFrame() },
                    { label: 'Stop FrameOS', onClick: () => stopFrame() },
                    { label: 'Reboot device', onClick: () => rebootFrame() },
                    {
                      label: 'Fast deploy (reload)',
                      onClick: () => {
                        fastDeployFrame()
                        openLogs()
                      },
                    },
                    {
                      label: 'Full deploy (recompile)',
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
                      color={unsavedChanges || undeployedChanges ? 'primary' : 'secondary'}
                      type="button"
                      onClick={() => {
                        saveFrame()
                        deployFrame()
                        openLogs()
                      }}
                    >
                      {!frame.last_successful_deploy_at
                        ? 'First deploy'
                        : `Save & ${requiresRecompilation ? 'full deploy' : 'fast deploy'}`}
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
