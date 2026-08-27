import { useValues } from 'kea'

import { BatteryIndicator, clampBatteryPercent } from '../../components/BatteryIndicator'
import type { FrameType } from '../../types'
import { frameMetricsPreviewLogic } from './frameMetricsPreviewLogic'

/** The newest battery reading the cloud attached to the frame itself, if any. */
export function frameLastBatteryPercent(frame: FrameType): number | null {
  return clampBatteryPercent(frame.last_metrics?.batteryPercent)
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
  return <BatteryIndicator percent={percent} size={size} className={className} />
}

/**
 * Battery charge for a frame row in a list, read from `last_metrics` only —
 * no metrics fetch per row. Cloud frames carry it; backend frames show
 * theirs in the header chips once selected.
 */
export function FrameSidebarBattery({
  frame,
  className,
}: {
  frame: FrameType
  className?: string
}): JSX.Element | null {
  const percent = frameLastBatteryPercent(frame)
  if (percent === null) {
    return null
  }
  return <BatteryIndicator percent={percent} size="sm" className={className} />
}
