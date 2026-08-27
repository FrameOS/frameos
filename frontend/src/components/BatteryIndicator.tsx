import clsx from 'clsx'

export type BatteryTone = 'full' | 'ok' | 'low' | 'critical'

/** Colour band for a charge level: green down to 50, amber to 20, red below. */
export function batteryTone(percent: number): BatteryTone {
  if (percent >= 80) {
    return 'full'
  }
  if (percent >= 50) {
    return 'ok'
  }
  if (percent >= 20) {
    return 'low'
  }
  return 'critical'
}

export function clampBatteryPercent(value: unknown): number | null {
  const percent = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(percent)) {
    return null
  }
  return Math.max(0, Math.min(100, Math.round(percent)))
}

const toneText: Record<BatteryTone, string> = {
  full: 'text-emerald-500',
  ok: 'text-emerald-500',
  low: 'text-amber-500',
  critical: 'text-red-500',
}

const toneBar: Record<BatteryTone, string> = {
  full: 'bg-emerald-500',
  ok: 'bg-emerald-500',
  low: 'bg-amber-500',
  critical: 'bg-red-500',
}

export function batteryTitle(percent: number): string {
  const tone = batteryTone(percent)
  return `Battery ${percent}%${tone === 'critical' ? ' — charge soon' : tone === 'low' ? ' — getting low' : ''}`
}

/**
 * A battery glyph filled to `percent`, coloured by charge band, with the
 * percentage next to it and (optionally) a thin progress bar underneath.
 */
export function BatteryIndicator({
  percent,
  size = 'md',
  showLabel = true,
  withBar = false,
  className,
  title,
}: {
  percent: number
  size?: 'sm' | 'md'
  showLabel?: boolean
  withBar?: boolean
  className?: string
  title?: string
}): JSX.Element {
  const level = Math.max(0, Math.min(100, Math.round(percent)))
  const tone = batteryTone(level)
  // Glyph geometry (viewBox 24×12): body 20×10 at (0.5,1), cap 2×4 at the right.
  const fillWidth = (17 * level) / 100
  const iconClassName = size === 'sm' ? 'h-2.5 w-5' : 'h-3 w-6'

  return (
    <span
      className={clsx('inline-flex flex-col gap-0.5', className)}
      title={title ?? batteryTitle(level)}
      data-testid="battery-indicator"
      data-battery-percent={level}
      data-battery-tone={tone}
    >
      <span className={clsx('inline-flex items-center gap-1 leading-none', toneText[tone])}>
        <svg viewBox="0 0 24 12" className={clsx('shrink-0', iconClassName)} aria-hidden>
          <rect x="0.5" y="1" width="20" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="21.5" y="4" width="2" height="4" rx="0.5" fill="currentColor" />
          <rect x="2" y="2.5" width={fillWidth} height="7" rx="1" fill="currentColor" />
        </svg>
        {showLabel ? (
          <span className={clsx('font-semibold tabular-nums', size === 'sm' ? 'text-[10px]' : 'text-[11px]')}>
            {level}%
          </span>
        ) : null}
      </span>
      {withBar ? (
        <span className="block h-1 w-full overflow-hidden rounded-full bg-slate-500/20">
          <span className={clsx('block h-full rounded-full', toneBar[tone])} style={{ width: `${level}%` }} />
        </span>
      ) : null}
    </span>
  )
}
