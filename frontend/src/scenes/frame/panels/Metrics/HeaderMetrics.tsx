import { useMemo } from 'react'
import { useValues } from 'kea'
import { ParentSize } from '@visx/responsive'
import { scaleLinear, scaleTime } from '@visx/scale'
import { max } from '@visx/vendor/d3-array'

import { AreaChart } from './AreaChart'
import { metricsLogic, type MetricPoint, type MetricSeries, type TimeRange } from './metricsLogic'

const chartHeight = 34
const chartMargin = { top: 3, right: 2, bottom: 3, left: 2 }
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

function HeaderMetricChart({ series, timeRange }: { series: MetricSeries[]; timeRange: TimeRange }) {
  const allData = useMemo(() => flattenSeriesData(series), [series])

  if (allData.length === 0) {
    return null
  }

  return (
    <div className="h-[34px] w-[118px] overflow-visible">
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
                gradientColor="#18181b"
              />
            </svg>
          )
        }}
      </ParentSize>
    </div>
  )
}

export function HeaderMetrics({ frameId }: { frameId: number }) {
  const { headerMetricsByCategory, headerMetricsTimeRange, latestMetricSummariesByCategory } = useValues(
    metricsLogic({ frameId })
  )
  const metricEntries = Object.entries(headerMetricsByCategory).filter(([, series]) => series.length > 0)

  if (!headerMetricsTimeRange || metricEntries.length === 0) {
    return null
  }

  return (
    <div className="relative z-50 hidden items-center gap-2 overflow-visible pl-2 pr-2 lg:flex">
      {metricEntries.map(([key, series]) => (
        <div
          key={key}
          className="flex h-[42px] items-center gap-1.5 rounded border border-gray-700 bg-gray-900/40 px-2"
        >
          <span className="flex-none whitespace-nowrap text-xs font-medium text-gray-300">
            {metricLabels[key] ?? key}
            {latestMetricSummariesByCategory[key] ? (
              <span className="ml-1 text-gray-400">{latestMetricSummariesByCategory[key]}</span>
            ) : null}
          </span>
          {key !== 'diskUsage' ? <HeaderMetricChart series={series} timeRange={headerMetricsTimeRange} /> : null}
        </div>
      ))}
    </div>
  )
}
