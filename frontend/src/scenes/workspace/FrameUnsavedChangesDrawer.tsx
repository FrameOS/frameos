import { XMarkIcon } from '@heroicons/react/24/outline'
import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import { useEffect, useRef } from 'react'

import { Spinner } from '../../components/Spinner'
import type { FrameType } from '../../types'
import { frameLogic, type ChangeDetail } from '../frame/frameLogic'
import { workspaceLogic } from './workspaceLogic'
import { frameHost } from '../../decorators/frame'

function UnsavedChangeRows({ changes }: { changes: ChangeDetail[] }): JSX.Element {
  if (changes.length === 0) {
    return <div className="frame-tool-muted text-sm leading-5">No unsaved changes.</div>
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
        </div>
      ))}
    </div>
  )
}

export function FrameUnsavedChangesDrawer({ frame }: { frame: FrameType }): JSX.Element {
  const { isFrameFormSubmitting, unsavedChangeDetails } = useValues(frameLogic({ frameId: frame.id }))
  const { hideDeployPlanModal, resetUnsavedChanges, saveFrame } = useActions(frameLogic({ frameId: frame.id }))
  const { closeFrameChangeDrawer } = useActions(workspaceLogic)
  // The drawer used to close on the click, which on the cloud hid the one
  // surface that could have shown the save's several seconds of work — a
  // settings push, then a store-scene version per scene, then the assignment
  // push. It now stays put and spins, and closes itself once the save lands.
  const saving = useRef(false)

  const closeDrawer = (): void => {
    hideDeployPlanModal()
    closeFrameChangeDrawer()
  }

  useEffect(() => {
    if (isFrameFormSubmitting) {
      saving.current = true
      return
    }
    if (!saving.current) {
      return
    }
    saving.current = false
    // A failed save leaves the changes pending: keep the drawer open so the
    // reason (reported as a failed task) is next to what it refused.
    if (unsavedChangeDetails.length === 0) {
      closeDrawer()
    }
    // closeDrawer is stable enough for this — the actions it calls are kea
    // action creators, and re-running on identity churn would close the
    // drawer a second time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFrameFormSubmitting, unsavedChangeDetails.length])

  const discardChanges = (): void => {
    resetUnsavedChanges()
    closeDrawer()
  }

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 flex w-[430px] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="frameos-divider flex items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
          <div className="min-w-0">
            <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
              {frame.name || frameHost(frame)}
            </div>
            <h2 className="frameos-strong truncate text-xl font-bold tracking-normal text-slate-950">
              Unsaved changes
            </h2>
          </div>
          <button
            type="button"
            onClick={closeDrawer}
            className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section className="space-y-2">
            <div className="frame-tool-heading text-sm font-semibold">Pending save</div>
            <div className="frame-tool-card rounded-[22px] p-4">
              <UnsavedChangeRows changes={unsavedChangeDetails} />
            </div>
          </section>
        </div>
        <div className="frameos-divider flex flex-wrap justify-end gap-2 border-t border-slate-200/80 px-5 py-4">
          <button
            type="button"
            onClick={closeDrawer}
            className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Close
          </button>
          <button
            type="button"
            disabled={isFrameFormSubmitting}
            onClick={discardChanges}
            className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
          >
            Discard
          </button>
          <button
            type="button"
            disabled={isFrameFormSubmitting}
            onClick={() => saveFrame()}
            className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-60"
          >
            {isFrameFormSubmitting ? <Spinner color="white" /> : null}
            {isFrameFormSubmitting ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
