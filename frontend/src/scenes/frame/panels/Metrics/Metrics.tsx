import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { useEffect, useRef } from 'react'
import {
  metricCardElementId,
  metricCardFromHash,
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
import { BoltIcon, InformationCircleIcon } from '@heroicons/react/24/outline'
import { Tooltip } from '../../../../components/Tooltip'

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
  wifiRssi: 'WiFi signal (RSSI)',
  batteryPercent: 'Battery charge (%)',
  batteryMillivolts: 'Battery voltage (mV)',
}

// Shown behind an (i) next to the card title; the number alone reads as
// "negative, therefore bad" to anyone who has not met dBm before.
const metricHelp: Record<string, JSX.Element> = {
  batteryPercent: (
    <div className="space-y-1">
      <div>
        Charge estimated from the cell voltage with a generic Li-ion discharge curve — a coarse figure, not a fuel
        gauge. Reported only by frames with a battery pin configured (board presets set it; otherwise `battery_pin` and
        `battery_divider` in the frame settings).
      </div>
      <div>Around 100% with the charger plugged in; the curve flattens between 50% and 20%, then drops quickly.</div>
    </div>
  ),
  batteryMillivolts: (
    <div>
      Cell voltage in millivolts after the divider correction. A single Li-ion cell sits near 4200 mV full and 3300 mV
      empty; below 3000 mV the frame stops refreshing to protect the cell.
    </div>
  ),
  wifiRssi: (
    <div className="space-y-1">
      <div>
        WiFi signal strength (RSSI) in dBm, as measured by the frame. The values are negative: closer to 0 is stronger.
      </div>
      <ul className="list-disc pl-4">
        <li>−30 to −50: excellent</li>
        <li>−50 to −67: good, fine for anything a frame does</li>
        <li>−67 to −75: fair, occasional slow pushes</li>
        <li>−75 to −85: weak, expect drops and reconnects</li>
        <li>below −85: unusable — move the frame or the router</li>
      </ul>
    </div>
  ),
}

const batteryMisreadHelp = (
  <div className="space-y-1">
    <div>
      Readings the samples around them contradict, left off the chart. The frame reads its cell through a resistor
      divider on an ADC pin, and every way that read can go wrong — a divider still charging, the supply sagging under
      the radio, two tasks sampling at once — pulls the number down, never up.
    </div>
    <div>
      So a lone reading far below its neighbours is a misread, not a discharge, and a frame that shows a red 0% for one
      sample and 78% for the next has not moved. Frequent misreads mean the frame wants a firmware update.
    </div>
  </div>
)

const latestDatapointFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/**
 * Scrolls the card a `#metric=...` link named into view. The cards only
 * exist once the samples have loaded, hence the retries — the same shape as
 * the settings-section scroll in FrameWorkspace.
 */
function scrollToMetricCard(category: string, attempt = 0): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return
  }
  window.requestAnimationFrame(() => {
    const card = document.getElementById(metricCardElementId(category))
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (attempt < 8) {
      window.setTimeout(() => scrollToMetricCard(category, attempt + 1), 50)
    }
  })
}

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
    batteryMisreadCount,
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
  const scrolledToHashCardRef = useRef(false)
  useEffect(() => {
    const category = metricCardFromHash()
    if (scrolledToHashCardRef.current || metricsLoading || metrics.length === 0 || !category) {
      return
    }
    scrolledToHashCardRef.current = true
    scrollToMetricCard(category)
  }, [metricsLoading, metrics.length])

  const latestMetric = sortedMetrics[sortedMetrics.length - 1]
  const latestMetricTimestamp = latestMetric ? metricTimestamp(latestMetric) : null
  const latestDatapointLabel =
    latestMetricTimestamp !== null && Number.isFinite(latestMetricTimestamp)
      ? latestDatapointFormatter.format(new Date(latestMetricTimestamp))
      : null

  return (
    <div
      className={clsx(
        'frame-tool-panel relative',
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
            <div
              key={key}
              id={metricCardElementId(key)}
              className="frame-tool-card mb-3 overflow-hidden rounded-[22px]"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <strong className="frame-tool-heading">{metricLabels[key] ?? key}</strong>
                {metricHelp[key] ? (
                  <Tooltip
                    title={metricHelp[key]}
                    className="frame-tool-muted"
                    titleClassName="w-72 text-xs leading-snug"
                  >
                    <InformationCircleIcon className="h-4 w-4" aria-label={`About ${metricLabels[key] ?? key}`} />
                  </Tooltip>
                ) : null}
                {latestMetricSummariesByCategory[key] ? (
                  <span className="frame-tool-muted">{latestMetricSummariesByCategory[key]}</span>
                ) : null}
                {batteryMisreadCount > 0 && (key === 'batteryPercent' || key === 'batteryMillivolts') ? (
                  <Tooltip
                    title={batteryMisreadHelp}
                    className="frame-tool-muted"
                    titleClassName="w-72 text-xs leading-snug"
                  >
                    <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-amber-600">
                      {batteryMisreadCount} misread{batteryMisreadCount === 1 ? '' : 's'} ignored
                    </span>
                  </Tooltip>
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
                  // select-none here only: dragging the brush must not select
                  // text, but the card titles above stay copyable.
                  'h-[200px] select-none p-0',
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
