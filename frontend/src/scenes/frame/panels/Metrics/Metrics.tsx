import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import {
  metricSeriesVisibilityKey,
  metricTimestamp,
  metricsLogic,
  metricsTimeRangeOptions,
  type MetricsTimeRangePreset,
} from './metricsLogic'
import { frameLogic } from '../../frameLogic'
import { ParentSize } from '@visx/responsive'
import { BrushChart } from './BrushChart'
import { Select } from '../../../../components/Select'
import { workspaceLogic } from '../../../workspace/workspaceLogic'
import { metricChartThemes, themeMetricSeries } from './chartTheme'
import { BoltIcon } from '@heroicons/react/24/outline'

const metricLabels: Record<string, string> = {
  load: 'Load',
  memoryUsage: 'Memory',
  diskUsage: 'Disk',
  processMemory: 'Process memory',
  runtimeDimensions: 'Runtime size',
  openFileDescriptors: 'Open file descriptors',
  cpuUsage: 'CPU usage',
  cpuTemperature: 'CPU temperature',
  cpuCount: 'CPU count',
  'runtime.sequence': 'Render sequence index (keeps incrementing)',
  'runtime.lastCompletedAgoMs': 'Seconds since last render',
}

const latestDatapointFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

interface MetricsProps {
  scrollContainer?: boolean
}

export function Metrics({ scrollContainer = true }: MetricsProps = {}) {
  const { frameId } = useValues(frameLogic)
  const { theme } = useValues(workspaceLogic)
  const {
    metrics,
    sortedMetrics,
    metricsByCategory,
    visibleMetricsByCategory,
    hiddenMetricSeries,
    metricsLoading,
    metricsTimeRange,
    visibleTimeRange,
    rebootMarkers,
    selectedTimeRangePreset,
    metricGapThresholdMs,
    latestMetricSummariesByCategory,
    requestMetricsLoading,
  } = useValues(metricsLogic({ frameId }))
  const {
    setSelectedTimeRange,
    resetSelectedTimeRange,
    setSelectedTimeRangePreset,
    toggleMetricSeries,
    requestMetrics,
  } = useActions(metricsLogic({ frameId }))
  const timeRangeOptions =
    selectedTimeRangePreset === 'custom'
      ? [...metricsTimeRangeOptions, { value: 'custom' as const, label: 'Custom' }]
      : metricsTimeRangeOptions
  const chartTheme = metricChartThemes[theme]
  const requestMetricsTooltipId = `frame-${frameId}-request-metrics-tooltip`
  const latestMetric = sortedMetrics[sortedMetrics.length - 1]
  const latestMetricTimestamp = latestMetric ? metricTimestamp(latestMetric) : null
  const latestDatapointLabel =
    latestMetricTimestamp !== null && Number.isFinite(latestMetricTimestamp)
      ? latestDatapointFormatter.format(new Date(latestMetricTimestamp))
      : null

  return (
    <div
      className={clsx(
        'frame-tool-panel relative select-none',
        scrollContainer ? 'h-full overflow-y-auto pr-2' : 'overflow-visible'
      )}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            aria-label="Metrics time range"
            className="!w-36 rounded-xl py-2 text-xs"
            disabled={metricsLoading || metrics.length === 0}
            options={timeRangeOptions}
            value={selectedTimeRangePreset}
            onChange={(value) => setSelectedTimeRangePreset(value as MetricsTimeRangePreset)}
          />
          <div className="frame-tool-muted text-sm">
            {metricsLoading
              ? 'Loading metrics...'
              : `${metrics.length} datapoint${metrics.length === 1 ? '' : 's'} loaded${
                  latestDatapointLabel ? `, last datapoint ${latestDatapointLabel}` : ''
                }`}
          </div>
        </div>
        <div className="group/request-metrics relative inline-flex shrink-0">
          <button
            type="button"
            onClick={requestMetrics}
            disabled={requestMetricsLoading}
            aria-describedby={requestMetricsTooltipId}
            className="frameos-secondary-button inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <BoltIcon className={clsx('h-4 w-4', requestMetricsLoading && 'animate-pulse')} />
            <span>{requestMetricsLoading ? 'Requesting...' : 'Request metrics'}</span>
          </button>
          <span
            id={requestMetricsTooltipId}
            role="tooltip"
            className="frameos-tooltip-panel pointer-events-none invisible absolute right-0 top-full z-50 mt-2 w-64 rounded-md p-3 text-left text-xs leading-snug opacity-0 transition group-hover/request-metrics:visible group-hover/request-metrics:opacity-100 group-focus-within/request-metrics:visible group-focus-within/request-metrics:opacity-100"
          >
            Requests a fresh metrics sample from this frame and adds it to the chart when it reports back.
          </span>
        </div>
      </div>
      {metricsLoading ? (
        <div className="frame-tool-card flex min-h-[12rem] items-center justify-center rounded-[22px] text-sm frame-tool-muted">
          Loading metrics...
        </div>
      ) : metrics.length === 0 ? (
        <div className="frame-tool-card flex min-h-[12rem] items-center justify-center rounded-[22px] text-sm frame-tool-muted">
          No metrics yet.
        </div>
      ) : (
        Object.entries(metricsByCategory).map(([key, series]) => {
          const themedSeries = themeMetricSeries(series, chartTheme)
          const visibleSeries = themeMetricSeries(visibleMetricsByCategory[key] ?? [], chartTheme)
          return (
            <div key={key} className="frame-tool-card mb-3 overflow-hidden rounded-[22px]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <strong className="frame-tool-heading">{metricLabels[key] ?? key}</strong>
                {latestMetricSummariesByCategory[key] ? (
                  <span className="frame-tool-muted">{latestMetricSummariesByCategory[key]}</span>
                ) : null}
                {series.length > 1 &&
                  themedSeries.map((chartSeries) => {
                    const hidden = hiddenMetricSeries[metricSeriesVisibilityKey(key, chartSeries.key)]
                    return (
                      <button
                        key={chartSeries.key}
                        type="button"
                        className={clsx(
                          'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500',
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
              <div
                className={clsx(
                  'h-[200px] p-0',
                  theme === 'dark' ? 'bg-[#18181b] text-white' : 'bg-white/70 text-slate-900'
                )}
              >
                <ParentSize>
                  {(parent) => (
                    <BrushChart
                      width={parent.width}
                      height={200}
                      margin={{ top: 20, left: 56, bottom: 12, right: 45 }}
                      series={visibleSeries}
                      totalTimeRange={metricsTimeRange}
                      visibleTimeRange={visibleTimeRange}
                      rebootMarkers={rebootMarkers}
                      gapThresholdMs={metricGapThresholdMs}
                      onTimeRangeChange={setSelectedTimeRange}
                      onResetTimeRange={resetSelectedTimeRange}
                      chartTheme={chartTheme}
                    />
                  )}
                </ParentSize>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
