import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { metricSeriesVisibilityKey, metricsLogic } from './metricsLogic'
import { frameLogic } from '../../frameLogic'
import { ParentSize } from '@visx/responsive'
import { BrushChart } from './BrushChart'

const metricLabels: Record<string, string> = {
  load: 'Load',
  memoryUsage: 'Memory',
  diskUsage: 'Disk',
  processMemory: 'Process memory',
}

export function Metrics() {
  const { frameId } = useValues(frameLogic)
  const {
    metrics,
    metricsByCategory,
    visibleMetricsByCategory,
    hiddenMetricSeries,
    metricsLoading,
    metricsTimeRange,
    visibleTimeRange,
    metricGapThresholdMs,
    latestMetricSummariesByCategory,
  } = useValues(metricsLogic({ frameId }))
  const { setSelectedTimeRange, resetSelectedTimeRange, toggleMetricSeries } = useActions(metricsLogic({ frameId }))

  return metricsLoading ? (
    <div>...</div>
  ) : metrics.length === 0 ? (
    <div>No Metrics yet</div>
  ) : (
    <div className="h-full p-2 relative select-none">
      <ParentSize>
        {(parent) =>
          Object.entries(metricsByCategory).map(([key, series]) => {
            const visibleSeries = visibleMetricsByCategory[key] ?? []
            return (
              <div key={key}>
                <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <strong>{metricLabels[key] ?? key}</strong>
                  {latestMetricSummariesByCategory[key] ? (
                    <span className="text-gray-400">{latestMetricSummariesByCategory[key]}</span>
                  ) : null}
                  {series.length > 1 &&
                    series.map((chartSeries) => {
                      const hidden = hiddenMetricSeries[metricSeriesVisibilityKey(key, chartSeries.key)]
                      return (
                        <button
                          key={chartSeries.key}
                          type="button"
                          className={clsx(
                            'inline-flex items-center gap-1 rounded-sm focus:outline-none focus:ring-1 focus:ring-blue-500',
                            hidden ? 'text-gray-500 line-through' : 'text-gray-200 hover:text-white'
                          )}
                          onClick={() => toggleMetricSeries(key, chartSeries.key)}
                        >
                          <span
                            className={clsx('inline-block h-2 w-3 rounded-sm', hidden ? 'opacity-30' : '')}
                            style={{ backgroundColor: chartSeries.color }}
                          />
                          {chartSeries.label}
                        </button>
                      )
                    })}
                </div>
                <div className="h-[200px] text-white">
                  <BrushChart
                    width={parent.width}
                    height={200}
                    series={visibleSeries}
                    totalTimeRange={metricsTimeRange}
                    visibleTimeRange={visibleTimeRange}
                    gapThresholdMs={metricGapThresholdMs}
                    onTimeRangeChange={setSelectedTimeRange}
                    onResetTimeRange={resetSelectedTimeRange}
                  />
                </div>
              </div>
            )
          })
        }
      </ParentSize>
    </div>
  )
}
