import { useActions, useValues } from 'kea'
import clsx from 'clsx'

import type { FrameType } from '../../types'
import { frameLogic } from '../frame/frameLogic'
import { isFrameControlMode } from '../../utils/frameControlMode'
import { DeployToFrameIcon } from './FrameChangeStatusIcon'
import { workspaceLogic } from './workspaceLogic'

interface FrameSceneSidebarCardProps {
  frame: FrameType
  unsavedChanges: boolean
  undeployedChanges: boolean
  className?: string
}

export function FrameSceneSidebarCard({
  frame,
  unsavedChanges,
  undeployedChanges,
  className,
}: FrameSceneSidebarCardProps): JSX.Element {
  const { hideDeployPlanModal, pullConfigFromFrame, saveFrame } = useActions(frameLogic({ frameId: frame.id }))
  const { configDrift, hasConfigDrift } = useValues(frameLogic({ frameId: frame.id }))
  const { frameChangeDrawerSelection } = useValues(workspaceLogic)
  const { closeChatDrawer, closeFrameChangeDrawer, openFrameChangeDrawer } = useActions(workspaceLogic)
  const deployDrawerIsOpen =
    frameChangeDrawerSelection?.frameId === frame.id && frameChangeDrawerSelection.kind === 'deploy'

  const openDeployPlan = (): void => {
    closeChatDrawer()
    if (deployDrawerIsOpen) {
      hideDeployPlanModal()
      closeFrameChangeDrawer()
      return
    }
    openFrameChangeDrawer(frame.id, 'deploy')
  }

  // On the device itself "Save" writes straight to the release's frame.json;
  // there is nothing to deploy from here.
  const frameControlMode = isFrameControlMode()

  return (
    <div className={clsx('grid gap-2', frameControlMode ? 'grid-cols-1' : 'grid-cols-2', className)}>
      {!frameControlMode && hasConfigDrift ? (
        <button
          type="button"
          title={`The frame edited its own config through its admin page. Differing fields: ${(configDrift ?? []).join(
            ', '
          )}`}
          onClick={() => {
            if (confirm(`Pull these changes from the frame into the backend?\n\n${(configDrift ?? []).join(', ')}`)) {
              pullConfigFromFrame()
            }
          }}
          className="frameos-warning-button col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <DeployToFrameIcon className="h-4 w-4 shrink-0 rotate-180" />
          Pull changes from frame
        </button>
      ) : null}
      <SaveFrameButton onSave={saveFrame} unsavedChanges={unsavedChanges} />
      {!frameControlMode ? (
        <button
          type="button"
          onClick={() => openDeployPlan()}
          className={clsx(
            'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            unsavedChanges || undeployedChanges ? 'frameos-warning-button' : 'frameos-secondary-button'
          )}
        >
          <DeployToFrameIcon className="h-4 w-4 shrink-0" />
          Deploy
        </button>
      ) : null}
    </div>
  )
}

function SaveFrameButton({ onSave, unsavedChanges }: { onSave: () => void; unsavedChanges: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSave}
      className={clsx(
        'w-full rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        unsavedChanges ? 'frameos-primary-action' : 'frameos-secondary-button'
      )}
    >
      Save
    </button>
  )
}
