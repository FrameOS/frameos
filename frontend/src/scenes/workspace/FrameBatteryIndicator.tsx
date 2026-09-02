import { useValues } from 'kea'

import { clampBatteryPercent } from '../../components/BatteryIndicator'
import type { FrameType } from '../../types'
import { FrameBatteryPopover } from './FrameBatteryPopover'
import { frameMetricsPreviewLogic } from './frameMetricsPreviewLogic'

/** The newest battery reading the cloud attached to the frame itself, if any. */
export function frameLastBatteryPercent(frame: FrameType): number | null {
  return clampBatteryPercent(frame.last_metrics?.batteryPercent)
}

/**
 * Battery charge of the selected frame, from its recent metrics (the same
 * logic the header chips and alert indicator mount) with the cloud's
 * `last_metrics` as fallback. Nothing for frames without a battery pin.
 * A bordered control, like the frame selector and actions menu beside it;
 * clicking opens the battery popup (FrameBatteryPopover).
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
  return <FrameBatteryPopover frame={frame} percent={percent} variant="panel" size={size} className={className} />
}

/**
 * Battery charge for a frame row in a list. Reads the same recent-metrics
 * logic the row's alert indicator already mounts — free, and unlike
 * `last_metrics` it is a series, so an ADC misread in the newest sample
 * cannot turn a full cell into a red 0% (utils/batteryMisreads.ts). Falls
 * back to `last_metrics` until those samples land. Looks like the plain
 * glyph the row always had, but the whole of it is the popup's button.
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
  return <FrameBatteryPopover frame={frame} percent={percent} variant="list" size="sm" className={className} />
}
