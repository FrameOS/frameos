import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import {
  metricSeriesVisibilityKey,
  metricsLogic,
  metricsTimeRangeOptions,
  type MetricsTimeRangePreset,
} from './metricsLogic'
import { frameLogic } from '../../frameLogic'
import { ParentSize } from '@visx/responsive'
import { BrushChart } from './BrushChart'
import { Select } from '../../../../components/Select'

const metricLabels: Record<string, string> = {
  load: 'Load',
  memoryUsage: 'Memory',
  diskUsage: 'Disk',
  processMemory: 'Process memory',
  runtimeDimensions: 'Runtime size',
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
    selectedTimeRangePreset,
    metricGapThresholdMs,
    latestMetricSummariesByCategory,
  } = useValues(metricsLogic({ frameId }))
  const { setSelectedTimeRange, resetSelectedTimeRange, setSelectedTimeRangePreset, toggleMetricSeries } = useActions(
    metricsLogic({ frameId })
  )
  const timeRangeOptions =
    selectedTimeRangePreset === 'custom'
      ? [...metricsTimeRangeOptions, { value: 'custom' as const, label: 'Custom' }]
      : metricsTimeRangeOptions

  return metricsLoading ? (
    <div>...</div>
  ) : metrics.length === 0 ? (
    <div>No Metrics yet</div>
  ) : (
    <div className="h-full p-2 relative select-none">
      <div className="mb-2 flex items-center gap-3">
        <Select
          aria-label="Metrics time range"
          className="!w-32 rounded border-gray-600 bg-gray-800 py-1 text-xs"
          options={timeRangeOptions}
          value={selectedTimeRangePreset}
          onChange={(value) => setSelectedTimeRangePreset(value as MetricsTimeRangePreset)}
        />
        <div className="text-sm text-gray-400">
          {metrics.length} point{metrics.length === 1 ? '' : 's'}
        </div>
      </div>
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
