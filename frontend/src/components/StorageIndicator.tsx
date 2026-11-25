import clsx from 'clsx'

import { frameStorageTone, type FrameStorageTone } from '../utils/frameSceneStorage'

export const storageToneText: Record<FrameStorageTone, string> = {
  ok: 'text-sky-500',
  filling: 'text-amber-500',
  full: 'text-red-500',
}

const storageToneBar: Record<FrameStorageTone, string> = {
  ok: 'bg-sky-500',
  filling: 'bg-amber-500',
  full: 'bg-red-500',
}

export function storageTitle(usedPercent: number): string {
  const tone = frameStorageTone(usedPercent)
  return `Disk ${usedPercent}% used${tone === 'full' ? ', almost full' : tone === 'filling' ? ', filling up' : ''}`
}

/** A disk drawn as a ring, the used share of it filled from the top. */
export function StorageGlyph({
  percent,
  className,
  strokeWidth = 2.5,
}: {
  percent: number
  className?: string
  strokeWidth?: number
}): JSX.Element {
  const radius = 8 - strokeWidth / 2
  const circumference = 2 * Math.PI * radius
  const used = (circumference * Math.max(0, Math.min(100, percent))) / 100
  return (
    <svg viewBox="0 0 16 16" className={clsx('shrink-0', className)} aria-hidden data-testid="storage-glyph">
      <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} opacity="0.25" />
      {used > 0 ? (
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={`${used} ${circumference}`}
          transform="rotate(-90 8 8)"
        />
      ) : null}
    </svg>
  )
}

/**
 * How full a frame's disk is: the ring glyph and the used percentage beside
 * it, colored by how full, with (optionally) a thin bar underneath. The disk's
 * sibling of BatteryIndicator, and laid out the same way so the two sit side
 * by side.
 */
export function StorageIndicator({
  percent,
  size = 'md',
  withBar = false,
  className,
  title,
}: {
  percent: number
  size?: 'sm' | 'md'
  withBar?: boolean
  className?: string
  title?: string
}): JSX.Element {
  const level = Math.max(0, Math.min(100, Math.round(percent)))
  const tone = frameStorageTone(level)
  return (
    <span
      className={clsx('inline-flex flex-col gap-0.5', className)}
      title={title ?? storageTitle(level)}
      data-testid="storage-indicator"
      data-storage-percent={level}
      data-storage-tone={tone}
    >
      <span className={clsx('inline-flex items-center gap-1 leading-none', storageToneText[tone])}>
        <StorageGlyph percent={level} className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        <span className={clsx('font-semibold tabular-nums', size === 'sm' ? 'text-[10px]' : 'text-[11px]')}>
          {level}%
        </span>
      </span>
      {withBar ? (
        <span className="block h-1 w-full overflow-hidden rounded-full bg-slate-500/20">
          <span className={clsx('block h-full rounded-full', storageToneBar[tone])} style={{ width: `${level}%` }} />
        </span>
      ) : null}
    </span>
  )
}
