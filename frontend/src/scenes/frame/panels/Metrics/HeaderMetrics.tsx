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
}: {
  series: MetricSeries[]
  timeRange: TimeRange
  chartTheme: MetricChartTheme
}) {
  const allData = useMemo(() => flattenSeriesData(series), [series])

  if (allData.length === 0) {
    return null
  }

  return (
    <div className="h-7 w-[104px] overflow-visible">
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
    <div className="relative z-50 hidden items-center gap-1.5 overflow-visible pl-1.5 pr-2 @5xl:flex">
      {metricEntries.map(([key, series]) => (
        <div
          key={key}
          className={clsx(
            'relative z-0 flex h-9 items-center gap-2 overflow-visible rounded-lg border px-2.5 shadow-sm backdrop-blur-sm transition-colors hover:z-[80] focus-within:z-[80]',
            theme === 'dark'
              ? 'border-white/10 bg-white/[0.06] shadow-black/10 hover:bg-white/[0.09]'
              : 'border-slate-200/70 bg-white/70 shadow-slate-950/5 hover:bg-white/90'
          )}
        >
          <span
            className={clsx(
              'flex min-w-[2.35rem] flex-none flex-col justify-center whitespace-nowrap leading-none',
              theme === 'dark' ? 'text-gray-300' : 'text-slate-700'
            )}
          >
            <span className="text-[10px] font-semibold uppercase">{metricLabels[key] ?? key}</span>
            {latestMetricSummariesByCategory[key] ? (
              <span
                className={clsx(
                  'mt-0.5 text-[11px] font-medium',
                  theme === 'dark' ? 'text-gray-400' : 'text-slate-500'
                )}
              >
                {latestMetricSummariesByCategory[key]}
              </span>
            ) : null}
          </span>
          {key !== 'diskUsage' ? (
            <HeaderMetricChart
              series={themeMetricSeries(series, chartTheme)}
              timeRange={headerMetricsTimeRange}
              chartTheme={chartTheme}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}
