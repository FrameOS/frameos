import { useActions } from 'kea'
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
  const { saveAndDeployFrame, saveFrame, showDeployPlanModal } = useActions(frameLogic({ frameId: frame.id }))
  const { closeChatDrawer } = useActions(workspaceLogic)
  const statusLabel = unsavedChanges ? 'Unsaved' : undeployedChanges ? 'Undeployed' : 'Saved'
  const statusIsActionable = unsavedChanges || undeployedChanges

  return (
    <div className={clsx('grid grid-cols-3 gap-2', className)}>
      {statusIsActionable ? (
        <button
          type="button"
          onClick={() => {
            closeChatDrawer()
            showDeployPlanModal()
          }}
          className={clsx(
            'rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            unsavedChanges ? 'frameos-warning-button' : 'frameos-primary-outline-action'
          )}
        >
          {statusLabel}
        </button>
      ) : (
        <span className="frameos-inset frameos-muted inline-flex items-center justify-center rounded-full border px-3 py-2 text-xs font-semibold">
          {statusLabel}
        </span>
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
        Deploy
      </button>
    </div>
  )
}
