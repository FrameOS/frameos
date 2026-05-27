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
  const { hideDeployPlanModal, hideUnsavedChangesModal, saveAndDeployFrame, saveFrame } = useActions(
    frameLogic({ frameId: frame.id })
  )
  const { requiresRecompilation } = useValues(frameLogic({ frameId: frame.id }))
  const { frameChangeDrawerSelection } = useValues(workspaceLogic)
  const { closeChatDrawer, closeFrameChangeDrawer, openFrameChangeDrawer } = useActions(workspaceLogic)
  const statusLabel = unsavedChanges ? 'Unsaved' : undeployedChanges ? 'Undeployed' : 'Deploy plan'
  const statusIsActionable = unsavedChanges || undeployedChanges
  const targetDrawerKind = unsavedChanges ? 'unsaved' : 'deploy'
  const drawerIsOpen =
    frameChangeDrawerSelection?.frameId === frame.id && frameChangeDrawerSelection.kind === targetDrawerKind
  const deployLabel = frame.last_successful_deploy_at && !requiresRecompilation ? 'Fast deploy' : 'Full deploy'
  const toggleFrameChangeDrawer = (): void => {
    closeChatDrawer()
    if (drawerIsOpen) {
      if (targetDrawerKind === 'unsaved') {
        hideUnsavedChangesModal()
      } else {
        hideDeployPlanModal()
      }
      closeFrameChangeDrawer()
      return
    }
    openFrameChangeDrawer(frame.id, targetDrawerKind)
  }

  return (
    <div className={clsx('grid grid-cols-3 gap-2', className)}>
      {statusIsActionable ? (
        <button
          type="button"
          onClick={toggleFrameChangeDrawer}
          className={clsx(
            'rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            'frameos-warning-button'
          )}
        >
          {statusLabel}
        </button>
      ) : (
        <button
          type="button"
          onClick={toggleFrameChangeDrawer}
          className="frameos-inset frameos-muted inline-flex items-center justify-center rounded-full border px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {statusLabel}
        </button>
      )}
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
        onClick={() => saveAndDeployFrame()}
        className={clsx(
          'rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
          unsavedChanges || undeployedChanges ? 'frameos-primary-action' : 'frameos-secondary-button'
        )}
      >
        {deployLabel}
      </button>
    </div>
  )
}
