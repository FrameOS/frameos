import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import type { MouseEvent, SVGProps } from 'react'
import { CloudArrowUpIcon, ComputerDesktopIcon } from '@heroicons/react/24/outline'

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

export function FrameChangeStatusIcon({
  frameId,
  variant = 'sidebar',
}: {
  frameId: number
  variant?: 'sidebar' | 'dashboard'
}): JSX.Element {
  const { undeployedChanges, unsavedChanges } = useValues(frameLogic({ frameId }))
  const { openFrameChangeDrawer } = useActions(workspaceLogic)
  const statusLabel = unsavedChanges ? 'Unsaved' : undeployedChanges ? 'Undeployed' : null
  const StatusIcon = unsavedChanges ? CloudArrowUpIcon : DeployToFrameIcon
  const isDashboard = variant === 'dashboard'
  const wrapperClassName = isDashboard
    ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition @4xl:h-12 @4xl:w-12 @4xl:rounded-2xl'
    : 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition'
  const idleClassName = isDashboard
    ? 'frameos-icon-tile bg-white/70 text-slate-700 shadow-sm'
    : 'text-current'
  const iconClassName = isDashboard ? 'h-7 w-7' : 'h-5 w-5'

  if (!statusLabel) {
    return (
      <span className={clsx(wrapperClassName, idleClassName)}>
        <ComputerDesktopIcon className={iconClassName} />
      </span>
    )
  }

  const openDrawer = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    openFrameChangeDrawer(frameId, unsavedChanges ? 'unsaved' : 'deploy')
  }

  return (
    <button
      type="button"
      title={`${statusLabel} changes`}
      aria-label={unsavedChanges ? 'Open unsaved changes' : 'Open deploy plan for undeployed changes'}
      onClick={openDrawer}
      className={clsx(
        wrapperClassName,
        'frameos-warning-button shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'
      )}
    >
      <StatusIcon className={iconClassName} />
    </button>
  )
}
