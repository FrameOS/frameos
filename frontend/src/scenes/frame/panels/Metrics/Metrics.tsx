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

interface MetricsProps {
  scrollContainer?: boolean
}

export function Metrics({ scrollContainer = true }: MetricsProps = {}) {
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
    <div className="frame-tool-panel frame-tool-card flex h-full items-center justify-center rounded-[22px] text-sm frame-tool-muted">
      Loading metrics...
    </div>
  ) : metrics.length === 0 ? (
    <div className="frame-tool-panel frame-tool-card flex h-full items-center justify-center rounded-[22px] text-sm frame-tool-muted">
      No metrics yet.
    </div>
  ) : (
    <div
      className={clsx(
        'frame-tool-panel relative select-none',
        scrollContainer ? 'h-full overflow-y-auto pr-2' : 'overflow-visible'
      )}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          aria-label="Metrics time range"
          className="!w-36 rounded-xl py-2 text-xs"
          options={timeRangeOptions}
          value={selectedTimeRangePreset}
          onChange={(value) => setSelectedTimeRangePreset(value as MetricsTimeRangePreset)}
        />
        <div className="frame-tool-muted text-sm">
          {metrics.length} datapoint{metrics.length === 1 ? '' : 's'}
        </div>
      </div>
      {Object.entries(metricsByCategory).map(([key, series]) => {
        const visibleSeries = visibleMetricsByCategory[key] ?? []
        return (
          <div key={key} className="frame-tool-card mb-3 overflow-hidden rounded-[22px]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <strong className="frame-tool-heading">{metricLabels[key] ?? key}</strong>
              {latestMetricSummariesByCategory[key] ? (
                <span className="frame-tool-muted">{latestMetricSummariesByCategory[key]}</span>
              ) : null}
              {series.length > 1 &&
                series.map((chartSeries) => {
                  const hidden = hiddenMetricSeries[metricSeriesVisibilityKey(key, chartSeries.key)]
                  return (
                    <button
                      key={chartSeries.key}
                      type="button"
                      className={clsx(
                        'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500',
                        hidden ? 'frame-tool-muted line-through opacity-60' : 'frame-tool-row hover:bg-white/80'
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
            <div className="h-[200px] bg-slate-950/95 p-0 text-white">
              <ParentSize>
                {(parent) => (
                  <BrushChart
                    width={parent.width}
                    height={200}
                    margin={{ top: 20, left: 56, bottom: 12, right: 45 }}
                    series={visibleSeries}
                    totalTimeRange={metricsTimeRange}
                    visibleTimeRange={visibleTimeRange}
                    gapThresholdMs={metricGapThresholdMs}
                    onTimeRangeChange={setSelectedTimeRange}
                    onResetTimeRange={resetSelectedTimeRange}
                  />
                )}
              </ParentSize>
            </div>
          </div>
        )
      })}
    </div>
  )
}
