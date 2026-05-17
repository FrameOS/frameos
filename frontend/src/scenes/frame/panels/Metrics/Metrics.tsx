import { useActions, useValues } from 'kea'
import { metricsLogic } from './metricsLogic'
import { frameLogic } from '../../frameLogic'
import { ParentSize } from '@visx/responsive'
import { BrushChart } from './BrushChart'

const metricLabels: Record<string, string> = {
  load: 'Load',
  memoryUsage: 'Memory',
  diskUsage: 'Disk',
}

export function Metrics() {
  const { frameId } = useValues(frameLogic)
  const {
    metrics,
    metricsByCategory,
    metricsLoading,
    metricsTimeRange,
    visibleTimeRange,
    metricGapThresholdMs,
    latestMetricSummariesByCategory,
  } = useValues(metricsLogic({ frameId }))
  const { setSelectedTimeRange, resetSelectedTimeRange } = useActions(metricsLogic({ frameId }))

  return metricsLoading ? (
    <div>...</div>
  ) : metrics.length === 0 ? (
    <div>No Metrics yet</div>
  ) : (
    <div className="h-full p-2 relative select-none">
      <ParentSize>
        {(parent) =>
          Object.entries(metricsByCategory).map(([key, series]) => (
            <div key={key}>
              <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <strong>{metricLabels[key] ?? key}</strong>
                {latestMetricSummariesByCategory[key] ? (
                  <span className="text-gray-400">{latestMetricSummariesByCategory[key]}</span>
                ) : null}
                {series.length > 1 &&
                  series.map((chartSeries) => (
                    <span key={chartSeries.key} className="inline-flex items-center gap-1">
                      <span
                        className="inline-block h-2 w-3 rounded-sm"
                        style={{ backgroundColor: chartSeries.color }}
                      />
                      {chartSeries.label}
                    </span>
                  ))}
              </div>
              <div className="h-[200px] text-white">
                <BrushChart
                  width={parent.width}
                  height={200}
                  series={series}
                  totalTimeRange={metricsTimeRange}
                  visibleTimeRange={visibleTimeRange}
                  gapThresholdMs={metricGapThresholdMs}
                  onTimeRangeChange={setSelectedTimeRange}
                  onResetTimeRange={resetSelectedTimeRange}
                />
              </div>
            </div>
          ))
        }
      </ParentSize>
    </div>
  )
}
