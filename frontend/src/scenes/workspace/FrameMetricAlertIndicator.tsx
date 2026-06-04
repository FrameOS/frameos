import { useValues } from 'kea'
import clsx from 'clsx'
import { ExclamationTriangleIcon } from '@heroicons/react/24/solid'

import type { FrameType } from '../../types'
import type { FrameMetricAlert } from '../../utils/frameMetricAlerts'
import { getFrameMetricAlerts, frameMetricAlertTitle } from '../../utils/frameMetricAlerts'
import { urls } from '../../urls'
import { frameMetricsPreviewLogic } from './frameMetricsPreviewLogic'
import { A } from 'kea-router'

export function FrameMetricAlertIndicator({
  frame,
  className,
  containerClassName,
}: {
  frame: FrameType
  className?: string
  containerClassName?: string
}): JSX.Element | null {
  const { sortedRecentMetrics } = useValues(frameMetricsPreviewLogic({ frameId: frame.id }))
  const alerts = getFrameMetricAlerts(frame, sortedRecentMetrics)

  if (alerts.length === 0) {
    return null
  }

  const title = frameMetricAlertTitle(alerts)

  return (
    <A
      href={urls.frame(frame.id, 'metrics')}
      className={clsx(
        'group/metric-alert relative inline-flex shrink-0 align-middle focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400',
        containerClassName
      )}
      aria-label={`${title}. Open metrics.`}
    >
      <ExclamationTriangleIcon
        role="img"
        aria-label={title}
        className={clsx('h-4 w-4 shrink-0 text-amber-400 drop-shadow-sm', className)}
      />
      <FrameMetricAlertPopup alerts={alerts} />
    </A>
  )
}

function FrameMetricAlertPopup({ alerts }: { alerts: FrameMetricAlert[] }): JSX.Element {
  return (
    <span className="frameos-tooltip-panel pointer-events-none invisible absolute left-1/2 top-full z-50 mt-2 w-64 -translate-x-1/2 rounded-md p-3 text-left text-xs opacity-0 transition group-hover/metric-alert:visible group-hover/metric-alert:opacity-100 group-focus-visible/metric-alert:visible group-focus-visible/metric-alert:opacity-100">
      <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-600">
        <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
        <span>Metrics issues</span>
      </span>
      <span className="flex flex-col gap-1.5">
        {alerts.map((alert) => (
          <span key={alert.key} className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
            <span>{alert.label}</span>
          </span>
        ))}
      </span>
    </span>
  )
}
