import { useActions, useValues } from 'kea'
import clsx from 'clsx'

import type { FrameType } from '../../types'
import { frameLogic } from '../frame/frameLogic'
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
  const { hideDeployPlanModal, hideUnsavedChangesModal, saveFrame } = useActions(frameLogic({ frameId: frame.id }))
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
    if (frameChangeDrawerSelection?.frameId === frame.id && frameChangeDrawerSelection.kind === 'unsaved') {
      hideUnsavedChangesModal()
    }
    openFrameChangeDrawer(frame.id, 'deploy')
  }

  return (
    <div className={clsx('grid grid-cols-2 gap-2', className)}>
      <button
        type="button"
        onClick={() => saveFrame()}
        className={clsx(
          'rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
          unsavedChanges ? 'frameos-primary-action' : 'frameos-secondary-button'
        )}
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => openDeployPlan()}
        className={clsx(
          'rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
          unsavedChanges || undeployedChanges ? 'frameos-primary-action' : 'frameos-secondary-button'
        )}
      >
        Deploy
      </button>
    </div>
  )
}
