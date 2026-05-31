import { useActions, useValues } from 'kea'
import clsx from 'clsx'

import type { FrameType } from '../../types'
import { frameLogic } from '../frame/frameLogic'
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
  const { hideDeployPlanModal, saveFrame } = useActions(frameLogic({ frameId: frame.id }))
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

  return (
    <div className={clsx('grid grid-cols-2 gap-2', className)}>
      <SaveFrameButton onSave={saveFrame} unsavedChanges={unsavedChanges} />
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
    </div>
  )
}

function SaveFrameButton({
  onSave,
  unsavedChanges,
}: {
  onSave: () => void
  unsavedChanges: boolean
}): JSX.Element {
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
