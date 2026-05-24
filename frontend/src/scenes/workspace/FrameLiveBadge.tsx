import clsx from 'clsx'

import type { FrameType } from '../../types'

export function FrameLiveBadge({ frame, className }: { frame: FrameType; className?: string }): JSX.Element | null {
  if ((frame.active_connections ?? 0) <= 0) {
    return null
  }

  return (
    <div
      className={clsx(
        'absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 shadow-sm ring-1 ring-emerald-200/80',
        className
      )}
    >
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
      Live
    </div>
  )
}
