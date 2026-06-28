import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import type { MouseEvent, SVGProps } from 'react'
import { ArrowsRightLeftIcon, CloudArrowUpIcon } from '@heroicons/react/24/outline'

import { frameLogic } from '../frame/frameLogic'
import { workspaceLogic } from './workspaceLogic'

export function DeployToFrameIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5.75 3.75h12.5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H5.75a1.5 1.5 0 0 1-1.5-1.5v-6.5a1.5 1.5 0 0 1 1.5-1.5Z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 10.25h10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7h5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21.25v-5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m9.25 18.5 2.75-2.75 2.75 2.75" />
    </svg>
  )
}

export function DeployPlanReadyIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5.5 4.25h13a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-13a1.5 1.5 0 0 1-1.5-1.5v-7.5a1.5 1.5 0 0 1 1.5-1.5Z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 9.75 2.25 2.25 5.25-5.25" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 14.75v3.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.75 19.75h6.5" />
    </svg>
  )
}

export function FrameChangeStatusIcon({
  frameId,
  variant = 'sidebar',
}: {
  frameId: number
  variant?: 'sidebar' | 'dashboard'
}): JSX.Element {
  const { hasFrameSyncChanges, undeployedChanges, unsavedChanges } = useValues(frameLogic({ frameId }))
  const { hideDeployPlanModal } = useActions(frameLogic({ frameId }))
  const { frameChangeDrawerSelection } = useValues(workspaceLogic)
  const { closeFrameChangeDrawer, focusFrame, openFrameChangeDrawer } = useActions(workspaceLogic)
  const statusLabel = unsavedChanges ? 'Unsaved' : hasFrameSyncChanges ? 'Sync' : undeployedChanges ? 'Undeployed' : null
  const drawerKind = unsavedChanges ? 'unsaved' : 'deploy'
  const drawerIsOpen = frameChangeDrawerSelection?.frameId === frameId && frameChangeDrawerSelection.kind === drawerKind
  const StatusIcon = unsavedChanges ? CloudArrowUpIcon : hasFrameSyncChanges ? ArrowsRightLeftIcon : DeployToFrameIcon
  const isDashboard = variant === 'dashboard'
  const wrapperClassName = isDashboard
    ? 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition'
    : 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition'
  const idleClassName = isDashboard ? 'frameos-icon-tile bg-white/70 text-slate-700 shadow-sm' : 'text-current'
  const iconClassName = isDashboard ? 'h-7 w-7' : 'h-5 w-5'

  const focusFrameAfterDrawerUpdate = (): void => {
    if (isDashboard) {
      return
    }
    focusFrame(frameId)
    if (typeof window === 'undefined') {
      return
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => focusFrame(frameId))
      })
    })
  }

  const openDrawer = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (drawerIsOpen) {
      hideDeployPlanModal()
      closeFrameChangeDrawer()
      return
    }
    openFrameChangeDrawer(frameId, drawerKind)
    focusFrameAfterDrawerUpdate()
  }

  if (!statusLabel) {
    return (
      <button
        type="button"
        title={drawerIsOpen ? 'Close deploy' : 'Open deploy'}
        aria-label={drawerIsOpen ? 'Close deploy' : 'Open deploy'}
        onClick={openDrawer}
        className={clsx(
          wrapperClassName,
          idleClassName,
          'frameos-change-status-button--idle',
          isDashboard ? 'frameos-change-status-button--idle-dashboard' : 'frameos-change-status-button--idle-sidebar',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'
        )}
      >
        <DeployPlanReadyIcon className={iconClassName} />
      </button>
    )
  }

  return (
    <button
      type="button"
      title={`${statusLabel} changes`}
      aria-label={
        drawerIsOpen
          ? unsavedChanges
            ? 'Close unsaved changes'
            : 'Close deploy'
          : unsavedChanges
          ? 'Open unsaved changes'
          : hasFrameSyncChanges
          ? 'Open sync'
          : 'Open deploy for undeployed changes'
      }
      onClick={openDrawer}
      className={clsx(
        wrapperClassName,
        'frameos-change-status-button focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        isDashboard ? 'frameos-change-status-button--dashboard' : 'frameos-change-status-button--sidebar',
        unsavedChanges ? 'frameos-change-status-button--unsaved' : 'frameos-change-status-button--undeployed'
      )}
    >
      <StatusIcon className={iconClassName} />
    </button>
  )
}
