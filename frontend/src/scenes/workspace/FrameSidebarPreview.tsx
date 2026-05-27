import { A } from 'kea-router'
import clsx from 'clsx'

import { FrameImage } from '../../components/FrameImage'
import type { FrameType } from '../../types'
import { urls } from '../../urls'
import { FrameLiveBadge } from './FrameLiveBadge'

const activeSurfaceClassName = 'frameos-active-surface'

export function FrameSidebarPreview({
  frame,
  active = false,
  className,
  mediaClassName,
}: {
  frame: FrameType
  active?: boolean
  className?: string
  mediaClassName?: string
}): JSX.Element {
  return (
    <A
      href={urls.frame(frame.id, 'preview')}
      className={clsx(
        'frameos-card block overflow-hidden rounded-2xl border bg-white/65 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-slate-300/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active ? activeSurfaceClassName : 'border-white/80',
        className
      )}
    >
      <div className={clsx('frameos-card-media relative h-32 bg-slate-100', mediaClassName)}>
        <FrameImage frameId={frame.id} refreshable={false} objectFit="contain" className="h-full w-full" />
        <FrameLiveBadge frame={frame} />
      </div>
    </A>
  )
}
