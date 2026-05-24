import { useMemo } from 'react'
import { useValues } from 'kea'
import clsx from 'clsx'
import { ParentSize } from '@visx/responsive'
import { scaleLinear, scaleTime } from '@visx/scale'
import { max } from '@visx/vendor/d3-array'

import { AreaChart } from './AreaChart'
import { metricsLogic, type MetricPoint, type MetricSeries, type TimeRange } from './metricsLogic'
import { workspaceLogic } from '../../../workspace/workspaceLogic'
import { metricChartThemes, themeMetricSeries, type MetricChartTheme } from './chartTheme'

const chartHeight = 28
const chartMargin = { top: 3, right: 1, bottom: 3, left: 1 }
const metricLabels: Record<string, string> = {
  load: 'Load',
  memoryUsage: 'Mem',
  diskUsage: 'Disk',
}
const compactMetricLabels: Record<string, string> = {
  load: 'L',
  memoryUsage: 'M',
  diskUsage: 'D',
}

const getValue = (point: MetricPoint) => point.y

function flattenSeriesData(series: MetricSeries[]): MetricPoint[] {
  return series.flatMap((chartSeries) => chartSeries.data)
}

function getValueMax(data: MetricPoint[]): number {
  return Math.max(max(data, getValue) || 0, 1)
}

function HeaderMetricChart({
  series,
  timeRange,
  chartTheme,
  className,
}: {
  series: MetricSeries[]
  timeRange: TimeRange
  chartTheme: MetricChartTheme
  className?: string
}) {
  const allData = useMemo(() => flattenSeriesData(series), [series])

  if (allData.length === 0) {
    return null
  }

  return (
    <div className={clsx('h-7 overflow-visible', className ?? 'w-[104px]')}>
      <ParentSize>
        {({ width }) => {
          if (width < 10) {
            return null
          }

          const xMax = Math.max(width - chartMargin.left - chartMargin.right, 0)
          const yMax = Math.max(chartHeight - chartMargin.top - chartMargin.bottom, 0)
          const xScale = scaleTime<number>({
            range: [0, xMax],
            domain: [new Date(timeRange.start), new Date(timeRange.end)],
          })
          const yScale = scaleLinear<number>({
            range: [yMax, 0],
            domain: [0, getValueMax(allData)],
            nice: true,
          })

          return (
            <svg width={width} height={chartHeight} className="overflow-visible">
              <AreaChart
                hideBottomAxis
                hideGrid
                hideLeftAxis
                hideRightAxis
                withPoints={false}
                showTooltip
                series={series}
                width={width}
                margin={chartMargin}
                yMax={yMax}
                xScale={xScale}
                yScale={yScale}
                gradientColor={chartTheme.background}
                chartTheme={chartTheme}
                compact
              />
            </svg>
          )
        }}
      </ParentSize>
    </div>
  )
}

export function HeaderMetrics({ frameId }: { frameId: number }) {
  const { theme } = useValues(workspaceLogic)
  const { headerMetricsByCategory, headerMetricsTimeRange, latestMetricSummariesByCategory } = useValues(
    metricsLogic({ frameId })
  )
  const metricEntries = Object.entries(headerMetricsByCategory).filter(([, series]) => series.length > 0)
  const chartTheme = metricChartThemes[theme]

  if (!headerMetricsTimeRange || metricEntries.length === 0) {
    return null
  }

  return (
    <div className="relative z-50 flex w-full max-w-full flex-nowrap items-center gap-1 overflow-visible pr-1 @4xl:w-auto @4xl:gap-1.5 @5xl:pr-2">
      {metricEntries.map(([key, series]) => (
        <div
          key={key}
          className={clsx(
            'relative z-0 flex h-8 shrink-0 items-center gap-1.5 overflow-visible rounded-lg border px-2 shadow-sm backdrop-blur-sm transition-colors hover:z-[80] focus-within:z-[80] @4xl:h-9 @4xl:gap-2 @4xl:px-2.5',
            theme === 'dark'
              ? 'border-white/10 bg-white/[0.06] shadow-black/10 hover:bg-white/[0.09]'
              : 'border-slate-200/70 bg-white/70 shadow-slate-950/5 hover:bg-white/90'
          )}
          title={`${metricLabels[key] ?? key}${
            latestMetricSummariesByCategory[key] ? ` ${latestMetricSummariesByCategory[key]}` : ''
          }`}
        >
          <span
            className={clsx(
              'flex min-w-0 flex-none items-baseline gap-1 whitespace-nowrap leading-none',
              theme === 'dark' ? 'text-gray-300' : 'text-slate-700'
            )}
          >
            <span className="text-[10px] font-semibold uppercase">
              <span className="@4xl:hidden">{compactMetricLabels[key] ?? metricLabels[key] ?? key}</span>
              <span className="hidden @4xl:inline">{metricLabels[key] ?? key}</span>
            </span>
            {latestMetricSummariesByCategory[key] ? (
              <span className={clsx('text-[11px] font-medium', theme === 'dark' ? 'text-gray-400' : 'text-slate-500')}>
                {latestMetricSummariesByCategory[key]}
              </span>
            ) : null}
          </span>
          {key !== 'diskUsage' ? (
            <HeaderMetricChart
              series={themeMetricSeries(series, chartTheme)}
              timeRange={headerMetricsTimeRange}
              chartTheme={chartTheme}
              className="hidden @5xl:block @5xl:w-20 @7xl:w-[104px]"
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}
