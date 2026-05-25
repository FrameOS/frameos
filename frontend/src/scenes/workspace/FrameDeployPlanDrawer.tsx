import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { XMarkIcon } from '@heroicons/react/24/outline'

import { Spinner } from '../../components/Spinner'
import { frameHost } from '../../decorators/frame'
import type { FrameType } from '../../types'
import { frameLogic, type ChangeDetail, type SummaryItem } from '../frame/frameLogic'

function SummaryRows({ items }: { items: SummaryItem[] }): JSX.Element | null {
  if (items.length === 0) {
    return null
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={`${item.label}:${item.value}`} className="rounded-xl bg-slate-500/10 px-3 py-2 text-sm">
          <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{item.label}</div>
          <div className="mt-0.5 text-[color:var(--tool-strong)]">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

function ChangeRows({ changes }: { changes: ChangeDetail[] }): JSX.Element | null {
  if (changes.length === 0) {
    return null
  }

  return (
    <div className="space-y-2">
      {changes.map((change) => (
        <div key={`${change.label}:${change.requiresFullDeploy}`} className="flex items-center gap-2 text-sm">
          <span
            className={clsx(
              'h-2.5 w-2.5 shrink-0 rounded-full',
              change.requiresFullDeploy ? 'bg-[color:var(--frameos-color-brass)]' : 'frameos-primary-fill'
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[color:var(--tool-strong)]">{change.label}</span>
          <span className="frame-tool-muted shrink-0 text-xs">{change.requiresFullDeploy ? 'Full' : 'Fast'}</span>
        </div>
      ))}
    </div>
  )
}

function DrawerHeading({ children }: { children: string }): JSX.Element {
  return <div className="frame-tool-heading text-sm font-semibold">{children}</div>
}

export function FrameDeployPlanDrawer({ frame }: { frame: FrameType }): JSX.Element | null {
  const {
    deployChangeDetails,
    deployPlanModalOpen,
    deployPlansError,
    deployPlansLoading,
    deployRecommendation,
    fastDeployPlanSummary,
    fullDeployPlanSummary,
  } = useValues(frameLogic({ frameId: frame.id }))
  const { hideDeployPlanModal, loadDeployPlans, saveAndDeployFrame, saveAndFastDeployFrame, saveAndFullDeployFrame } =
    useActions(frameLogic({ frameId: frame.id }))

  if (!deployPlanModalOpen) {
    return null
  }

  const closeAndRun = (action: () => void): void => {
    action()
    hideDeployPlanModal()
  }

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 flex w-[430px] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="frameos-divider flex items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
          <div className="min-w-0">
            <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
              {frame.name || frameHost(frame)}
            </div>
            <h2 className="frameos-strong truncate text-xl font-bold tracking-normal text-slate-950">Deploy plan</h2>
          </div>
          <button
            type="button"
            onClick={hideDeployPlanModal}
            className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {deployPlansLoading ? (
            <div className="flex items-center gap-3 text-sm">
              <Spinner />
              <span className="frame-tool-muted">Loading deploy plan...</span>
            </div>
          ) : deployPlansError ? (
            <div className="frame-tool-card rounded-[22px] p-4">
              <div className="text-sm font-semibold text-red-500">{deployPlansError}</div>
              <button
                type="button"
                onClick={() => loadDeployPlans()}
                className="frameos-secondary-button mt-3 rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {deployRecommendation ? (
                <section className="space-y-2">
                  <DrawerHeading>{deployRecommendation.title}</DrawerHeading>
                  <div className="frame-tool-card rounded-[22px] p-4">
                    <div className="frame-tool-muted text-sm leading-5">{deployRecommendation.description}</div>
                  </div>
                </section>
              ) : null}
              {deployChangeDetails.length > 0 ? (
                <section className="space-y-2">
                  <DrawerHeading>Pending changes</DrawerHeading>
                  <div className="frame-tool-card rounded-[22px] p-4">
                    <ChangeRows changes={deployChangeDetails} />
                  </div>
                </section>
              ) : null}
              <section className="space-y-2">
                <DrawerHeading>Fast deploy</DrawerHeading>
                <SummaryRows
                  items={
                    fastDeployPlanSummary.length > 0
                      ? fastDeployPlanSummary
                      : [{ label: 'Behavior', value: 'Reload FrameOS with the current frame configuration' }]
                  }
                />
              </section>
              {fullDeployPlanSummary.length > 0 ? (
                <section className="space-y-2">
                  <DrawerHeading>Full deploy</DrawerHeading>
                  <SummaryRows items={fullDeployPlanSummary} />
                </section>
              ) : null}
            </div>
          )}
        </div>
        <div className="frameos-divider flex flex-wrap justify-end gap-2 border-t border-slate-200/80 px-5 py-4">
          <button
            type="button"
            onClick={() => hideDeployPlanModal()}
            className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => closeAndRun(saveAndFastDeployFrame)}
            className={clsx(
              'rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              deployRecommendation?.mode === 'fast' ? 'frameos-primary-action' : 'frameos-secondary-button'
            )}
          >
            Fast deploy
          </button>
          <button
            type="button"
            onClick={() =>
              closeAndRun(deployRecommendation?.mode === 'full' ? saveAndFullDeployFrame : saveAndDeployFrame)
            }
            className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Full deploy
          </button>
        </div>
      </div>
    </div>
  )
}
