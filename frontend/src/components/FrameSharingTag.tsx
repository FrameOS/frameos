import clsx from 'clsx'
import { A } from 'kea-router'
import { UsersIcon } from '@heroicons/react/24/outline'

import { urls } from '../urls'
import { frameIsSharedWithMe, frameSharingLabel, type FrameWithAccess } from '../utils/frameAccess'

/**
 * Says whose a shared frame is (FrameOS Cloud, cloud/docs/sharing.md): "Shared
 * by Olive" on a frame someone shares with you, "Shared in Home" on one of
 * yours that is in a project. Nothing on a frame that is yours alone, which
 * is every frame on the other control planes.
 *
 * `compact` is the frames list's version: the icon alone, the words in its
 * tooltip. Both lead to the people page, where the sharing is changed (or,
 * for a frame shared with you, left).
 */
export function FrameSharingTag({
  frame,
  compact,
  className,
}: {
  frame?: FrameWithAccess | null
  compact?: boolean
  className?: string
}): JSX.Element | null {
  const label = frameSharingLabel(frame)
  if (!label) {
    return null
  }
  const project = frame?.access?.project?.name
  const title = frameIsSharedWithMe(frame) && project ? `${label}, in the project ${project}` : label
  if (compact) {
    return (
      <span title={title} aria-label={title} className={clsx('inline-flex shrink-0 text-slate-400', className)}>
        <UsersIcon aria-hidden className="h-3.5 w-3.5" />
      </span>
    )
  }
  return (
    <A
      href={urls.settings('people')}
      title={`${title}. Open People`}
      className={clsx(
        'frameos-muted inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        className
      )}
    >
      <UsersIcon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </A>
  )
}
