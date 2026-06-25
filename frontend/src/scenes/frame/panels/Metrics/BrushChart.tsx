import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { scaleTime, scaleLinear } from '@visx/scale'
import { Brush } from '@visx/brush'
import { Bounds } from '@visx/brush/lib/types'
import BaseBrush from '@visx/brush/lib/BaseBrush'
import { PatternLines } from '@visx/pattern'
import { Group } from '@visx/group'
import { max } from '@visx/vendor/d3-array'
import { BrushHandleRenderProps } from '@visx/brush/lib/BrushHandle'
import { AreaChart } from './AreaChart'
import { WithParentSizeProps } from '@visx/responsive/lib/enhancers/withParentSize'
import type { MetricPoint, MetricSeries, RebootMarker, TimeRange } from './metricsLogic'
import { metricChartThemes, type MetricChartTheme } from './chartTheme'

// Initialize some variables
const brushMargin = { top: 10, bottom: 15, left: 50, right: 20 }
const chartSeparation = 30

// accessors
const getDate = (m: MetricPoint) => m.x
const getValue = (m: MetricPoint) => m.y
const fallbackTimeRange = () => ({ start: Date.now() - 60 * 60 * 1000, end: Date.now() })
const rebootTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function normalizeTimeRange(start: number, end: number): TimeRange {
  const min = Math.min(start, end)
  const max = Math.max(start, end)
  return max - min >= 1000 ? { start: min, end: max } : { start: min - 500, end: max + 500 }
}

function getDataTimeRange(data: MetricPoint[]): TimeRange {
  const timestamps = data.map((d) => getDate(d).getTime()).filter(Number.isFinite)
  if (timestamps.length === 0) {
    return fallbackTimeRange()
  }
  return normalizeTimeRange(Math.min(...timestamps), Math.max(...timestamps))
}

function getValueMax(data: MetricPoint[]): number {
  return Math.max(max(data, getValue) || 0, 1)
}

function getBrushPosition(timeRange: TimeRange, scale: (date: Date) => number | undefined, width: number) {
  const start = Math.max(0, Math.min(scale(new Date(timeRange.start)) || 0, width))
  const end = Math.max(0, Math.min(scale(new Date(timeRange.end)) || 0, width))

  return {
    start: { x: start },
    end: { x: end },
  }
}

function flattenSeriesData(series: MetricSeries[], axis?: 'left' | 'right'): MetricPoint[] {
  return series.filter((chartSeries) => !axis || chartSeries.axis === axis).flatMap((chartSeries) => chartSeries.data)
}

export type BrushProps = {
  width: number
  height: number
  margin?: { top: number; right: number; bottom: number; left: number }
  compact?: boolean
  series: MetricSeries[]
  totalTimeRange: TimeRange | null
  visibleTimeRange: TimeRange | null
  rebootMarkers?: RebootMarker[]
  gapThresholdMs: number | null
  onTimeRangeChange: (start: number, end: number) => void
  onResetTimeRange: () => void
  chartTheme?: MetricChartTheme
}

export function BrushChart({
  compact = false,
  width,
  height,
  series,
  totalTimeRange,
  visibleTimeRange,
  rebootMarkers = [],
  gapThresholdMs,
  onTimeRangeChange,
  onResetTimeRange,
  chartTheme = metricChartThemes.dark,
  margin = {
    top: 20,
    left: 56,
    bottom: 20,
    right: 45,
  },
}: BrushProps & WithParentSizeProps) {
  const brushRef = useRef<BaseBrush | null>(null)
  const patternId = useId().replace(/:/g, '')
  const selectedBrushStyle = useMemo(
    () => ({
      fill: `url(#${patternId})`,
      stroke: chartTheme.brushSelectionStroke,
    }),
    [chartTheme.brushSelectionStroke, patternId]
  )

  const innerHeight = height - margin.top - margin.bottom
  const topChartBottomMargin = compact ? chartSeparation / 2 : chartSeparation + 10
  const topChartHeight = 0.8 * innerHeight - topChartBottomMargin
  const bottomChartHeight = innerHeight - topChartHeight - chartSeparation

  // bounds
  const xMax = Math.max(width - margin.left - margin.right, 0)
  const yMax = Math.max(topChartHeight, 0)
  const xBrushMax = Math.max(width - brushMargin.left - brushMargin.right, 0)
  const yBrushMax = Math.max(bottomChartHeight - brushMargin.top - brushMargin.bottom, 0)
  const allData = useMemo(() => flattenSeriesData(series), [series])
  const chartTimeRange = visibleTimeRange ?? totalTimeRange ?? getDataTimeRange(allData)
  const brushTimeRangeBase = totalTimeRange ?? chartTimeRange
  const brushTimeRange = visibleTimeRange
    ? normalizeTimeRange(
        Math.min(brushTimeRangeBase.start, visibleTimeRange.start),
        Math.max(brushTimeRangeBase.end, visibleTimeRange.end)
      )
    : brushTimeRangeBase
  const filteredSeries = useMemo(
    () =>
      series.map((chartSeries) => ({
        ...chartSeries,
        data: chartSeries.data.filter((d) => {
          const timestamp = getDate(d).getTime()
          return timestamp >= chartTimeRange.start && timestamp <= chartTimeRange.end
        }),
      })),
    [series, chartTimeRange.start, chartTimeRange.end]
  )
  const filteredData = useMemo(() => flattenSeriesData(filteredSeries), [filteredSeries])
  const filteredLeftData = useMemo(() => flattenSeriesData(filteredSeries, 'left'), [filteredSeries])
  const filteredRightData = useMemo(() => flattenSeriesData(filteredSeries, 'right'), [filteredSeries])
  const leftData = useMemo(() => flattenSeriesData(series, 'left'), [series])
  const rightData = useMemo(() => flattenSeriesData(series, 'right'), [series])

  // scales
  const dateScale = useMemo(
    () =>
      scaleTime<number>({
        range: [0, xMax],
        domain: [new Date(chartTimeRange.start), new Date(chartTimeRange.end)],
      }),
    [xMax, chartTimeRange.start, chartTimeRange.end]
  )
  const valueScale = useMemo(
    () =>
      scaleLinear<number>({
        range: [yMax, 0],
        domain: [0, getValueMax(filteredLeftData.length > 0 ? filteredLeftData : filteredData)],
        nice: true,
      }),
    [yMax, filteredData, filteredLeftData]
  )
  const valueScaleRight = useMemo(
    () =>
      scaleLinear<number>({
        range: [yMax, 0],
        domain: [0, Math.max(getValueMax(filteredRightData), 100)],
        nice: true,
      }),
    [yMax, filteredRightData]
  )
  const brushDateScale = useMemo(
    () =>
      scaleTime<number>({
        range: [0, xBrushMax],
        domain: [new Date(brushTimeRange.start), new Date(brushTimeRange.end)],
      }),
    [xBrushMax, brushTimeRange.start, brushTimeRange.end]
  )
  const brushValueScale = useMemo(
    () =>
      scaleLinear({
        range: [yBrushMax, 0],
        domain: [0, getValueMax(leftData.length > 0 ? leftData : allData)],
        nice: true,
      }),
    [yBrushMax, allData, leftData]
  )
  const brushValueScaleRight = useMemo(
    () =>
      scaleLinear({
        range: [yBrushMax, 0],
        domain: [0, Math.max(getValueMax(rightData), 100)],
        nice: true,
      }),
    [yBrushMax, rightData]
  )

  const initialBrushPosition = useMemo(
    () => getBrushPosition(chartTimeRange, brushDateScale, xBrushMax),
    [brushDateScale, chartTimeRange.start, chartTimeRange.end, xBrushMax]
  )

  useEffect(() => {
    const brush = brushRef.current
    if (!brush || brush.state.isBrushing || xBrushMax <= 0 || yBrushMax <= 0) {
      return
    }

    const position = getBrushPosition(chartTimeRange, brushDateScale, xBrushMax)
    const x0 = Math.min(position.start.x, position.end.x)
    const x1 = Math.max(position.start.x, position.end.x)
    const current = brush.state.extent
    if (Math.abs(current.x0 - x0) < 1 && Math.abs(current.x1 - x1) < 1) {
      return
    }

    brush.setState((previous) => ({
      ...previous,
      start: { x: x0, y: 0 },
      end: { x: x1, y: yBrushMax },
      extent: { x0, x1, y0: 0, y1: yBrushMax },
      bounds: { x0: 0, x1: xBrushMax, y0: 0, y1: yBrushMax },
      activeHandle: null,
      brushingType: undefined,
      isBrushing: false,
    }))
  }, [brushDateScale, chartTimeRange.start, chartTimeRange.end, xBrushMax, yBrushMax])

  const onBrushChange = (domain: Bounds | null) => {
    if (!domain) return
    const { x0, x1 } = domain
    if (Number.isFinite(x0) && Number.isFinite(x1)) {
      onTimeRangeChange(Number(x0), Number(x1))
    }
  }

  return (
    <div style={{ userSelect: 'none' }}>
      <svg width={width} height={height}>
        <rect x={0} y={0} width={width} height={height} fill={chartTheme.background} rx={14} />
        <AreaChart
          hideBottomAxis={compact}
          series={filteredSeries}
          width={width}
          margin={{ ...margin, bottom: topChartBottomMargin }}
          yMax={yMax}
          xScale={dateScale}
          yScale={valueScale}
          yScaleRight={valueScaleRight}
          gradientColor={chartTheme.background}
          gapThresholdMs={gapThresholdMs}
          showTooltip
          chartTheme={chartTheme}
        >
          <RebootMarkers
            markers={rebootMarkers}
            xScale={dateScale}
            xMax={xMax}
            yMax={yMax}
            stroke={chartTheme.brushAccent}
          />
        </AreaChart>
        <AreaChart
          hideBottomAxis
          hideLeftAxis
          series={series}
          width={width}
          yMax={yBrushMax}
          xScale={brushDateScale}
          yScale={brushValueScale}
          yScaleRight={brushValueScaleRight}
          margin={brushMargin}
          hideRightAxis
          top={topChartHeight + topChartBottomMargin + margin.top}
          gradientColor={chartTheme.background}
          withPoints={false}
          gapThresholdMs={gapThresholdMs}
          chartTheme={chartTheme}
        >
          <RebootMarkers
            markers={rebootMarkers}
            xScale={brushDateScale}
            xMax={xBrushMax}
            yMax={yBrushMax}
            stroke={chartTheme.brushAccent}
            compact
          />
          <PatternLines
            id={patternId}
            height={8}
            width={8}
            stroke={chartTheme.brushAccent}
            strokeWidth={1}
            orientation={['diagonal']}
          />
          <Brush
            xScale={brushDateScale}
            yScale={brushValueScale}
            width={xBrushMax}
            height={yBrushMax}
            margin={brushMargin}
            handleSize={8}
            innerRef={brushRef}
            resizeTriggerAreas={['left', 'right']}
            brushDirection="horizontal"
            initialBrushPosition={initialBrushPosition}
            onChange={onBrushChange}
            onClick={onResetTimeRange}
            selectedBoxStyle={selectedBrushStyle}
            useWindowMoveEvents
            renderBrushHandle={(props) => <BrushHandle {...props} chartTheme={chartTheme} />}
          />
        </AreaChart>
      </svg>
    </div>
  )
}

function RebootMarkers({
  markers,
  xScale,
  xMax,
  yMax,
  stroke,
  compact = false,
}: {
  markers: RebootMarker[]
  xScale: (date: Date) => number | undefined
  xMax: number
  yMax: number
  stroke: string
  compact?: boolean
}) {
  const [hoveredMarker, setHoveredMarker] = useState<(RebootMarker & { x: number }) | null>(null)

  if (markers.length === 0 || xMax <= 0 || yMax <= 0) {
    return null
  }

  const visibleMarkers = markers
    .map((marker) => {
      const x = xScale(marker.timestamp)
      return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= xMax ? { ...marker, x } : null
    })
    .filter(Boolean) as (RebootMarker & { x: number })[]

  if (visibleMarkers.length === 0) {
    return null
  }

  if (compact) {
    return (
      <Group pointerEvents="none">
        {visibleMarkers.map((marker) => (
          <line
            key={marker.logId ?? marker.metricId ?? marker.timestamp.getTime()}
            x1={marker.x}
            x2={marker.x}
            y1={0}
            y2={yMax}
            stroke={stroke}
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.7}
          >
            <title>{rebootTooltipTitle(marker)}</title>
          </line>
        ))}
      </Group>
    )
  }

  return (
    <Group>
      {visibleMarkers.map((marker) => (
        <React.Fragment key={marker.logId ?? marker.metricId ?? marker.timestamp.getTime()}>
          <line
            x1={marker.x}
            x2={marker.x}
            y1={0}
            y2={yMax}
            stroke={stroke}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            opacity={0.85}
          />
          <rect
            x={Math.max(marker.x - 6, 0)}
            y={0}
            width={Math.min(12, xMax - Math.max(marker.x - 6, 0))}
            height={yMax}
            fill="transparent"
            pointerEvents="all"
            onPointerEnter={() => setHoveredMarker(marker)}
            onPointerMove={() => setHoveredMarker(marker)}
            onPointerLeave={() => setHoveredMarker(null)}
          />
        </React.Fragment>
      ))}
      {hoveredMarker ? <RebootMarkerTooltip marker={hoveredMarker} xMax={xMax} yMax={yMax} stroke={stroke} /> : null}
    </Group>
  )
}

function rebootKindLabel(kind?: string): string {
  switch (kind) {
    case 'initiated':
      return 'Initiated restart'
    case 'oom':
      return 'OOM restart'
    case 'error':
      return 'Error restart'
    case 'watchdog':
      return 'Watchdog restart'
    case 'clean':
      return 'Clean restart'
    default:
      return 'Restart'
  }
}

function rebootTooltipRows(marker: RebootMarker): string[] {
  return [
    rebootTimestampFormatter.format(marker.timestamp),
    marker.reason || rebootKindLabel(marker.kind),
    marker.source ? `Source: ${marker.source}` : '',
    marker.message ? `Message: ${marker.message}` : '',
    marker.error ? `Error: ${marker.error}` : '',
    marker.serviceResult ? `Service result: ${marker.serviceResult}` : '',
    marker.exitCode ? `Exit code: ${marker.exitCode}` : '',
    marker.exitStatus ? `Exit status: ${marker.exitStatus}` : '',
    marker.previousBootId && marker.bootId ? `Boot: ${marker.previousBootId} -> ${marker.bootId}` : '',
  ].filter(Boolean)
}

function rebootTooltipTitle(marker: RebootMarker): string {
  return rebootTooltipRows(marker).join('\n')
}

function RebootMarkerTooltip({
  marker,
  xMax,
  yMax,
  stroke,
}: {
  marker: RebootMarker & { x: number }
  xMax: number
  yMax: number
  stroke: string
}) {
  const rows = rebootTooltipRows(marker)
  const widestRowLength = rows.reduce((length, row) => Math.max(length, row.length), 0)
  const tooltipWidth = Math.min(Math.max(190, widestRowLength * 6.5 + 24), Math.max(190, xMax))
  const tooltipHeight = 18 + rows.length * 16
  const rawLeft = marker.x + tooltipWidth + 12 <= xMax ? marker.x + 12 : marker.x - tooltipWidth - 12
  const left = Math.min(Math.max(rawLeft, 0), Math.max(xMax - tooltipWidth, 0))
  const top = Math.min(Math.max(12, 0), Math.max(yMax - tooltipHeight, 0))

  return (
    <g transform={`translate(${left}, ${top})`} pointerEvents="none">
      <rect x={2} y={3} width={tooltipWidth} height={tooltipHeight} rx={6} fill="rgba(0,0,0,0.22)" />
      <rect width={tooltipWidth} height={tooltipHeight} rx={6} fill="rgba(17,24,39,0.94)" stroke={stroke} />
      {rows.map((row, index) => (
        <text key={`${row}-${index}`} x={10} y={18 + index * 16} fontFamily="Arial" fontSize={11} fill="#f8fafc">
          {row}
        </text>
      ))}
    </g>
  )
}

// We need to manually offset the handles for them to be rendered at the right position
function BrushHandle({
  x,
  height,
  isBrushActive,
  chartTheme,
}: BrushHandleRenderProps & { chartTheme: MetricChartTheme }) {
  const pathWidth = 8
  const pathHeight = 15
  if (!isBrushActive) {
    return null
  }
  return (
    <Group left={x + pathWidth / 2} top={(height - pathHeight) / 2}>
      <path
        fill={chartTheme.brushHandleFill}
        d="M -4.5 0.5 L 3.5 0.5 L 3.5 15.5 L -4.5 15.5 L -4.5 0.5 M -1.5 4 L -1.5 12 M 0.5 4 L 0.5 12"
        stroke={chartTheme.brushHandleStroke}
        strokeWidth="1"
        style={{ cursor: 'ew-resize' }}
      />
    </Group>
  )
}
