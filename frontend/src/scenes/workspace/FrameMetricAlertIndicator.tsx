import { useValues } from 'kea'
import clsx from 'clsx'
import { ExclamationTriangleIcon } from '@heroicons/react/24/solid'

import type { FrameType } from '../../types'
import { getFrameMetricAlerts, frameMetricAlertTitle } from '../../utils/frameMetricAlerts'
import { frameMetricsPreviewLogic } from './frameMetricsPreviewLogic'

export function FrameMetricAlertIndicator({
  frame,
  className,
}: {
  frame: FrameType
  className?: string
}): JSX.Element | null {
  const { sortedRecentMetrics } = useValues(frameMetricsPreviewLogic({ frameId: frame.id }))
  const alerts = getFrameMetricAlerts(frame, sortedRecentMetrics)

  if (alerts.length === 0) {
    return null
  }

  return (
    <ExclamationTriangleIcon
      role="img"
      aria-label={frameMetricAlertTitle(alerts)}
      title={frameMetricAlertTitle(alerts)}
      className={clsx('h-4 w-4 shrink-0 text-amber-400 drop-shadow-sm', className)}
    />
  )
}
