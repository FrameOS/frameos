import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { ArrowsRightLeftIcon } from '@heroicons/react/24/outline'

import type { FrameType } from '../../types'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import { frameLogic } from '../frame/frameLogic'
import { DeployToFrameIcon } from './FrameChangeStatusIcon'
import { FrameLocalDeployMenu } from './FrameLocalDeployMenu'
import { workspaceLogic } from './workspaceLogic'
import { frameMenuActionIsAllowed, workspaceMode } from './workspaceSurfaces'

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
  const { hideDeployPlanModal, saveFrame, saveAndDeployFrame } = useActions(frameLogic({ frameId: frame.id }))
  const { hasFrameSyncChanges } = useValues(frameLogic({ frameId: frame.id }))
  const { frameChangeDrawerSelection } = useValues(workspaceLogic)
  const { closeChatDrawer, closeFrameChangeDrawer, openFrameChangeDrawer } = useActions(workspaceLogic)
  const deployDrawerIsOpen =
    frameChangeDrawerSelection?.frameId === frame.id && frameChangeDrawerSelection.kind === 'deploy'
  const inFrameAdminMode = isInFrameAdminMode()
  const showSync = hasFrameSyncChanges
  const DeployButtonIcon = showSync ? ArrowsRightLeftIcon : DeployToFrameIcon

  const openDeployPlan = (): void => {
    closeChatDrawer()
    if (deployDrawerIsOpen) {
      hideDeployPlanModal()
      closeFrameChangeDrawer()
      return
    }
    openFrameChangeDrawer(frame.id, 'deploy')
  }

  // The backend's Deploy opens the deploy-plan drawer (rebuild over SSH,
  // gated through the 'deploy' menu action). The cloud has no drawer and no
  // /deploy — its deploy is saveAndDeployFrame's cloud branch: push the
  // settings that map, then one durable set_scenes push through the
  // uploadScenes shim. Save stays because it maps onto the declarative
  // settings push (utils/cloudFrameApi.ts).
  const mode = workspaceMode()
  const canDeploy = frameMenuActionIsAllowed(mode, 'deploy')
  const canLocalDeploy = frameMenuActionIsAllowed(mode, 'localDeploy')
  const cloudDeploy = mode === 'cloud'

  return (
    <div
      className={clsx('grid gap-2', canDeploy || canLocalDeploy || cloudDeploy ? 'grid-cols-2' : 'grid-cols-1', className)}
    >
      <SaveFrameButton onSave={saveFrame} unsavedChanges={unsavedChanges} />
      {canLocalDeploy && inFrameAdminMode ? (
        <FrameLocalDeployMenu
          frameId={frame.id}
          buttonTitle="Frame actions"
          buttonClassName={unsavedChanges ? 'frameos-warning-button' : 'frameos-secondary-button'}
        />
      ) : cloudDeploy ? (
        <button
          type="button"
          title="Push the current scenes to the frame"
          onClick={() => saveAndDeployFrame()}
          className={clsx(
            'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            unsavedChanges || undeployedChanges ? 'frameos-warning-button' : 'frameos-secondary-button'
          )}
        >
          <DeployToFrameIcon className="h-4 w-4 shrink-0" />
          Deploy
        </button>
      ) : !canDeploy ? null : (
        <button
          type="button"
          onClick={() => openDeployPlan()}
          className={clsx(
            'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            showSync || unsavedChanges || undeployedChanges ? 'frameos-warning-button' : 'frameos-secondary-button'
          )}
        >
          <DeployButtonIcon className="h-4 w-4 shrink-0" />
          {showSync ? 'Sync' : 'Deploy'}
        </button>
      )}
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
