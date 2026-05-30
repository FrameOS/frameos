import { useActions, useValues } from 'kea'
import clsx from 'clsx'

import type { FrameType } from '../../types'
import { frameLogic, type ChangeDetail } from '../frame/frameLogic'
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
  const { isFrameFormSubmitting, unsavedChangeDetails } = useValues(frameLogic({ frameId: frame.id }))
  const { hideDeployPlanModal, resetUnsavedChanges, saveFrame } = useActions(frameLogic({ frameId: frame.id }))
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
      <SaveFrameButton
        isSubmitting={isFrameFormSubmitting}
        onDiscard={resetUnsavedChanges}
        onSave={saveFrame}
        unsavedChangeDetails={unsavedChangeDetails}
        unsavedChanges={unsavedChanges}
      />
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
  isSubmitting,
  onDiscard,
  onSave,
  unsavedChangeDetails,
  unsavedChanges,
}: {
  isSubmitting: boolean
  onDiscard: () => void
  onSave: () => void
  unsavedChangeDetails: ChangeDetail[]
  unsavedChanges: boolean
}): JSX.Element {
  const changedSinceSave = unsavedChangeDetails.filter((change) => !change.label.startsWith('FrameOS upgrade'))

  return (
    <div className="group relative min-w-0">
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
      {unsavedChanges ? (
        <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[calc(100vw-2rem)] opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <div className="frame-tool-card rounded-2xl border border-white/80 bg-white/95 p-4 text-left shadow-2xl shadow-slate-500/25 backdrop-blur-xl">
            <div className="frame-tool-heading text-sm font-semibold">Changed since last save</div>
            {changedSinceSave.length > 0 ? (
              <div className="mt-3 space-y-2">
                {changedSinceSave.map((change, index) => (
                  <div key={`${change.label}:${index}`} className="flex items-center gap-2 text-sm">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[color:var(--frameos-color-brass)]" />
                    <span className="min-w-0 flex-1 truncate text-[color:var(--tool-strong)]">{change.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="frame-tool-muted mt-3 text-sm">There are unsaved frame changes.</div>
            )}
            <p className="frame-tool-muted mt-3 text-sm">Save or discard these changes before deploying this frame.</p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onDiscard}
                disabled={isSubmitting}
                className="frameos-danger-button rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-40"
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
