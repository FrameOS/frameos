import { useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'

import { BatteryIndicator, batteryTitle, clampBatteryPercent } from '../../components/BatteryIndicator'
import type { FrameType } from '../../types'
import { metricCardHash } from '../frame/panels/Metrics/metricsLogic'
import { urls } from '../../urls'
import { frameMetricsPreviewLogic } from './frameMetricsPreviewLogic'

/** The newest battery reading the cloud attached to the frame itself, if any. */
export function frameLastBatteryPercent(frame: FrameType): number | null {
  return clampBatteryPercent(frame.last_metrics?.batteryPercent)
}

/** The Metrics panel, scrolled to the battery chart. */
function batteryMetricsUrl(frame: FrameType): string {
  return urls.frame(frame.id, 'metrics') + metricCardHash('batteryPercent')
}

function BatteryLink({
  frame,
  percent,
  size,
  className,
}: {
  frame: FrameType
  percent: number
  size: 'sm' | 'md'
  className?: string
}): JSX.Element {
  return (
    <A
      href={batteryMetricsUrl(frame)}
      title={`${batteryTitle(percent)} — open metrics`}
      aria-label={`${batteryTitle(percent)}. Open metrics.`}
      className={clsx(
        'shrink-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        className
      )}
    >
      <BatteryIndicator percent={percent} size={size} title="" />
    </A>
  )
}

/**
 * Battery charge of the selected frame, from its recent metrics (the same
 * logic the header chips and alert indicator mount) with the cloud's
 * `last_metrics` as fallback. Nothing for frames without a battery pin.
 */
export function FrameBatteryIndicator({
  frame,
  size = 'md',
  className,
}: {
  frame: FrameType
  size?: 'sm' | 'md'
  className?: string
}): JSX.Element | null {
  const { latestBatteryPercent } = useValues(frameMetricsPreviewLogic({ frameId: frame.id }))
  const percent = latestBatteryPercent ?? frameLastBatteryPercent(frame)
  if (percent === null) {
    return null
  }
  return <BatteryLink frame={frame} percent={percent} size={size} className={className} />
}

/**
 * Battery charge for a frame row in a list. Reads the same recent-metrics
 * logic the row's alert indicator already mounts — free, and unlike
 * `last_metrics` it is a series, so an ADC misread in the newest sample
 * cannot turn a full cell into a red 0% (utils/batteryMisreads.ts). Falls
 * back to `last_metrics` until those samples land.
 */
export function FrameSidebarBattery({
  frame,
  className,
}: {
  frame: FrameType
  className?: string
}): JSX.Element | null {
  const { latestBatteryPercent } = useValues(frameMetricsPreviewLogic({ frameId: frame.id }))
  const percent = latestBatteryPercent ?? frameLastBatteryPercent(frame)
  if (percent === null) {
    return null
  }
  return <BatteryLink frame={frame} percent={percent} size="sm" className={className} />
}
