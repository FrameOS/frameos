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
import { terminalLogic } from './panels/Terminal/terminalLogic'
import { Switch } from '../../components/Switch'
import { Form } from 'kea-forms'
import { Field } from '../../components/Field'
import { frameSettingsLogic } from './panels/FrameSettings/frameSettingsLogic'
import { logsLogic } from './panels/Logs/logsLogic'
import { isFrameControlMode } from '../../utils/frameControlMode'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import { Modal } from '../../components/Modal'

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
    lastDeploy,
    undeployedSummaryItems,
    fastDeployPlanSummary,
    fullDeployPlanSummary,
    deployRecommendation,
    deployPlan,
    deployPlansLoading,
    deployPlansError,
    deployPlanModalOpen,
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
    showDeployPlanModal,
    hideDeployPlanModal,
  } = useActions(frameLogic(frameLogicProps))
  useMountedLogic(assetsLogic(frameLogicProps)) // Don't lose what we downloaded when navigating away from the tab
  useMountedLogic(terminalLogic(frameLogicProps))
  useMountedLogic(frameSettingsLogic(frameLogicProps))
  useMountedLogic(logsLogic(frameLogicProps))
  const { openLogs } = useActions(panelsLogic(frameLogicProps))

  const canDeployAgent = frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret && mode === 'rpios'
  const canRestartAgent = frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret
  const canAgentRunCommands =
    frame?.agent && frame.agent.agentEnabled && frame.agent.agentSharedSecret && frame.agent.agentRunCommands
  const frameControlMode = isFrameControlMode()
  const inFrameAdminMode = isInFrameAdminMode()

  const logoutFromFrame = async () => {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' })
    window.location.href = '/login'
  }

  const dropdownItems = inFrameAdminMode
    ? [{ label: 'Logout', onClick: logoutFromFrame }]
    : [
        { label: 'Re-Render', onClick: () => renderFrame() },
        { label: 'Restart FrameOS', onClick: () => restartFrame() },
        { label: 'Stop FrameOS', onClick: () => stopFrame() },
        { label: 'Reboot device', onClick: () => rebootFrame() },
        { label: 'Deploy plan', onClick: () => showDeployPlanModal() },
        {
          label: 'Fast deploy / reload',
          onClick: () => {
            fastDeployFrame()
            openLogs()
          },
        },
        ...(!frameControlMode
          ? [
              {
                label: 'Full deploy / recompile',
                onClick: () => {
                  fullDeployFrame()
                  openLogs()
                },
              },
            ]
          : []),
        ...(frameControlMode ? [{ label: 'Logout', onClick: logoutFromFrame }] : []),
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
      ]

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
                {!inFrameAdminMode && (unsavedChanges || undeployedChanges) ? (
                  <button
                    className="pr-2 text-[#9a9ad0] underline underline-offset-2"
                    type="button"
                    onClick={() => showDeployPlanModal()}
                  >
                    {unsavedChanges
                      ? `Unsaved changes${requiresRecompilation ? ', requires full deploy!' : ''}`
                      : frame.last_successful_deploy_at
                      ? 'Undeployed changes'
                      : 'Not yet deployed'}
                  </button>
                ) : null}

                <DropdownMenu buttonColor="secondary" className="items-center" items={dropdownItems} />
                {inFrameAdminMode ? (
                  <div className="flex pl-2 space-x-2">
                    <Button color="secondary" type="button" onClick={() => renderFrame()}>
                      Rerender
                    </Button>
                  </div>
                ) : (
                  <div className="flex pl-2 space-x-2">
                    <Button color={unsavedChanges ? 'primary' : 'secondary'} type="button" onClick={() => saveFrame()}>
                      Save
                    </Button>
                    {frameControlMode ? (
                      <>
                        <Button
                          color={unsavedChanges || undeployedChanges ? 'primary' : 'secondary'}
                          type="button"
                          onClick={() => {
                            saveFrame()
                            fastDeployFrame()
                            openLogs()
                          }}
                        >
                          Reload
                        </Button>
                      </>
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                )}
              </div>
            }
          />
          <Panels />
          <Modal
            open={deployPlanModalOpen}
            onClose={hideDeployPlanModal}
            title="Deploy Plan"
          >
            <div className="p-5 space-y-4 text-sm text-gray-100">
              {deployPlansLoading ? (
                <div className="text-gray-300">Loading…</div>
              ) : (
                <>
                  {deployRecommendation ? (
                    <div className="rounded border border-blue-700/60 bg-blue-900/20 p-4">
                      <div className="font-medium text-blue-100">{deployRecommendation.title}</div>
                      <div className="mt-1 text-blue-50">{deployRecommendation.description}</div>
                    </div>
                  ) : null}

                  {deployPlan?.notes?.length ? (
                    <div>
                      <div className="mb-2 text-xs text-gray-400">What happens</div>
                      <ul className="space-y-1 text-gray-200">
                        {deployPlan.notes.map((note, index) => (
                          <li key={`modal-note-${index}`}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {unsavedChanges ? (
                    <div>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="text-xs text-gray-400">Unsaved changes</div>
                        <Button color="secondary" size="small" type="button" onClick={() => resetUnsavedChanges()}>
                          Reset changes
                        </Button>
                      </div>
                      <ul className="space-y-1">
                        {unsavedChangeDetails.map((change, index) => (
                          <li key={`unsaved-${change.label}-${index}`} className="flex items-center justify-between gap-3">
                            <span>{change.label}</span>
                            <span className="text-right text-gray-300">
                              {change.requiresFullDeploy ? 'Needs full deploy' : 'Fast deploy ok'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {undeployedChanges ? (
                    <div>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="text-xs text-gray-400">{lastDeploy ? 'Undeployed changes' : 'Not yet deployed'}</div>
                        {lastDeploy ? (
                          <Button color="secondary" size="small" type="button" onClick={() => resetUndeployedChanges()}>
                            Reset changes
                          </Button>
                        ) : null}
                      </div>
                      <ul className="space-y-1">
                        {lastDeploy
                          ? undeployedChangeDetails.map((change, index) => (
                              <li
                                key={`undeployed-${change.label}-${index}`}
                                className="flex items-center justify-between gap-3"
                              >
                                <span>{change.label}</span>
                                <span className="text-right text-gray-300">
                                  {change.requiresFullDeploy ? 'Needs full deploy' : 'Fast deploy ok'}
                                </span>
                              </li>
                            ))
                          : undeployedSummaryItems.map((item, index) => (
                              <li key={`not-deployed-${item.label}-${index}`} className="flex items-center justify-between gap-3">
                                <span>{item.label}</span>
                                <span className="text-right text-gray-300">{item.value}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {undeployedChanges && undeployedSummaryItems.length > 0 ? (
                    <div>
                      <div className="mb-2 text-xs text-gray-400">Deployment summary</div>
                      <ul className="space-y-1">
                        {undeployedSummaryItems.map((item, index) => (
                          <li key={`summary-${item.label}-${index}`} className="flex items-center justify-between gap-3">
                            <span>{item.label}</span>
                            <span className="text-right text-gray-300">{item.value}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div>
                    <div className="mb-2 text-xs text-gray-400">Fast deploy</div>
                    {fastDeployPlanSummary.length > 0 ? (
                      <ul className="space-y-1">
                        {fastDeployPlanSummary.map((item, index) => (
                          <li key={`modal-fast-${item.label}-${index}`} className="flex items-center justify-between gap-3">
                            <span>{item.label}</span>
                            <span className="text-right text-gray-300">{item.value}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-gray-300">Unavailable</div>
                    )}
                  </div>

                  <div>
                    <div className="mb-2 text-xs text-gray-400">Full deploy</div>
                    {fullDeployPlanSummary.length > 0 ? (
                      <ul className="space-y-1">
                        {fullDeployPlanSummary.map((item, index) => (
                          <li key={`modal-full-${item.label}-${index}`} className="flex items-center justify-between gap-3">
                            <span>{item.label}</span>
                            <span className="text-right text-gray-300">{item.value}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-gray-300">Unavailable</div>
                    )}
                  </div>

                  <div className="flex flex-wrap justify-end gap-2 border-t border-gray-700 pt-4">
                    <Button
                      color={deployRecommendation?.mode === 'fast' ? 'primary' : 'secondary'}
                      type="button"
                      onClick={() => {
                        saveFrame()
                        fastDeployFrame()
                        openLogs()
                        hideDeployPlanModal()
                      }}
                    >
                      Fast deploy
                    </Button>
                    {!frameControlMode ? (
                      <Button
                        color={deployRecommendation?.mode === 'full' ? 'primary' : 'secondary'}
                        type="button"
                        onClick={() => {
                          saveFrame()
                          fullDeployFrame()
                          openLogs()
                          hideDeployPlanModal()
                        }}
                      >
                        Full deploy
                      </Button>
                    ) : null}
                  </div>
                </>
              )}
              {deployPlansError ? <div className="text-red-300">{deployPlansError}</div> : null}
            </div>
          </Modal>
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
