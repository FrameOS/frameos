import React, { useId, useMemo, useState } from 'react'
import { Group } from '@visx/group'
import { AreaClosed, LinePath } from '@visx/shape'
import { AxisLeft, AxisBottom, AxisRight, AxisScale } from '@visx/axis'
import { LinearGradient } from '@visx/gradient'
import { curveMonotoneX } from '@visx/curve'
import type { MetricPoint, MetricSeries } from './metricsLogic'
import { metricChartThemes, type MetricChartTheme } from './chartTheme'
import { splitByGap } from './chartData'

/**
 * A series to draw. `segments` — gap-split, downsampled runs — come from
 * chartData.prepareChartSeries; a caller without them (the header
 * sparklines) gets the raw data split at gaps here instead.
 */
export type AreaChartSeries = MetricSeries & { segments?: MetricPoint[][] }

/**
 * Sample circles are drawn while they still mean something: past this
 * many drawn points per pixel of width they merge into a thick line and
 * cost a DOM node each.
 */
const MAX_POINT_MARKER_DENSITY = 1 / 4

// Initialize some variables
const axisBottomTickLabelBaseProps = {
  textAnchor: 'middle' as const,
  fontFamily: 'Arial',
  fontSize: 10,
}
const axisLeftTickLabelBaseProps = {
  dx: '-0.25em',
  dy: '0.25em',
  fontFamily: 'Arial',
  fontSize: 10,
  textAnchor: 'end' as const,
}
const axisRightTickLabelBaseProps = {
  dx: '0.25em',
  dy: '0.25em',
  fontFamily: 'Arial',
  fontSize: 10,
  textAnchor: 'start' as const,
}
const axisTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const tooltipTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

// accessors
const getDate = (m: MetricPoint) => m.x
const getValue = (m: MetricPoint) => m.y

interface ChartTooltipRow {
  key: string
  label: string
  color: string
  formattedValue: string
  y: number
}

interface ChartTooltipRowAccumulator {
  key: string
  label: string
  color: string
  unit?: MetricSeries['unit']
  values: number[]
  yValues: number[]
}

interface ChartTooltipSnapshotAccumulator {
  timestamp: number
  x: number
  rowsByKey: Map<string, ChartTooltipRowAccumulator>
}

interface ChartTooltipSnapshot {
  timestamp: number
  x: number
  rows: ChartTooltipRow[]
}

interface ChartTooltipState extends ChartTooltipSnapshot {
  pointerY: number
}

function getScaleTicks(scale: AxisScale<number>, count: number): number[] {
  if ('ticks' in scale && typeof scale.ticks === 'function') {
    return scale.ticks(count).map(Number)
  }
  return []
}

function formatBytes(value: number): string {
  const absValue = Math.abs(value)
  if (absValue >= 1024 * 1024 * 1024) {
    return `${Math.floor(value / (1024 * 1024 * 102.4)) / 10}G`
  }
  if (absValue >= 1024 * 1024) {
    return `${Math.floor(value / (1024 * 102.4)) / 10}M`
  }
  if (absValue >= 1024) {
    return `${Math.floor(value / 102.4) / 10}K`
  }
  return String(value)
}

function formatMetricTick(value: number, unit?: MetricSeries['unit']): string {
  if (unit === 'bytes') {
    return formatBytes(value)
  }
  if (unit === 'percent') {
    return `${value}%`
  }
  if (unit === 'pixels') {
    return `${value}px`
  }
  if (unit === 'seconds') {
    return `${value}s`
  }
  return value >= 1000000
    ? `${Math.floor(value / 100000) / 10}M`
    : value >= 1000
    ? `${Math.floor(value / 1000)}K`
    : String(value)
}

function formatMetricNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value)
  }

  const absValue = Math.abs(value)
  const precision = absValue < 1 ? 3 : absValue < 100 ? 2 : 1
  return value.toFixed(precision).replace(/\.?0+$/, '')
}

function formatMetricValue(value: number, unit?: MetricSeries['unit']): string {
  if (unit === 'bytes') {
    return formatBytes(value)
  }
  if (unit === 'percent') {
    return `${formatMetricNumber(value)}%`
  }
  if (unit === 'pixels') {
    return `${formatMetricNumber(value)}px`
  }
  if (unit === 'seconds') {
    return `${formatMetricNumber(value)}s`
  }
  return formatMetricNumber(value)
}

function formatMetricValueRange(values: number[], unit?: MetricSeries['unit']): string {
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const formattedMin = formatMetricValue(minValue, unit)
  const formattedMax = formatMetricValue(maxValue, unit)

  return formattedMin === formattedMax ? formattedMin : `${formattedMin} - ${formattedMax}`
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function metricDate(value: Date | number | { valueOf(): number }): Date {
  return value instanceof Date ? value : new Date(value.valueOf())
}

function formatAxisTimestamp(value: Date | number | { valueOf(): number }): string {
  return axisTimeFormatter.format(metricDate(value))
}

function formatTooltipTimestamp(timestamp: number): string {
  return tooltipTimestampFormatter.format(new Date(timestamp))
}

/** The snapshot nearest to pixel `x`; snapshots are sorted by x, so a binary search. */
function closestTooltipSnapshot(snapshots: ChartTooltipSnapshot[], x: number): ChartTooltipSnapshot | null {
  if (snapshots.length === 0) {
    return null
  }
  let low = 0
  let high = snapshots.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (snapshots[mid].x < x) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  const after = snapshots[Math.min(low, snapshots.length - 1)]
  const before = snapshots[Math.max(low - 1, 0)]
  return Math.abs(after.x - x) < Math.abs(before.x - x) ? after : before
}

function ChartTooltip({
  tooltip,
  xMax,
  yMax,
  chartTheme,
  compact = false,
}: {
  tooltip: ChartTooltipState
  xMax: number
  yMax: number
  chartTheme: MetricChartTheme
  compact?: boolean
}) {
  const timeLabel = formatTooltipTimestamp(tooltip.timestamp)
  const widestRowLength = tooltip.rows.reduce(
    (length, row) => Math.max(length, row.label.length + row.formattedValue.length),
    timeLabel.length
  )
  const tooltipWidth = Math.min(Math.max(170, widestRowLength * 7 + 48), Math.max(170, xMax))
  const tooltipHeight = 32 + tooltip.rows.length * 18
  const rawLeft = tooltip.x + tooltipWidth + 12 <= xMax ? tooltip.x + 12 : tooltip.x - tooltipWidth - 12
  const left = Math.min(Math.max(rawLeft, 0), Math.max(xMax - tooltipWidth, 0))
  const top = compact
    ? yMax + 8
    : Math.min(Math.max(tooltip.pointerY - tooltipHeight / 2, 0), Math.max(yMax - tooltipHeight, 0))

  return (
    <g pointerEvents="none">
      <line x1={tooltip.x} x2={tooltip.x} y1={0} y2={yMax} stroke={chartTheme.tooltipBorder} strokeWidth={1} />
      {tooltip.rows.map((row) => (
        <circle
          key={row.key}
          cx={tooltip.x}
          cy={row.y}
          r={4}
          fill={chartTheme.tooltipBackground}
          stroke={row.color}
          strokeWidth={1.5}
        />
      ))}
      <g transform={`translate(${left}, ${top})`}>
        <rect
          x={2}
          y={3}
          width={tooltipWidth}
          height={tooltipHeight}
          rx={6}
          fill={chartTheme.tooltipShadow}
          opacity={0.9}
        />
        <rect
          width={tooltipWidth}
          height={tooltipHeight}
          rx={6}
          fill={chartTheme.tooltipBackground}
          stroke={chartTheme.tooltipBorder}
        />
        <text x={10} y={19} fontFamily="Arial" fontSize={10} fill={chartTheme.tooltipMutedText}>
          {timeLabel}
        </text>
        {tooltip.rows.map((row, index) => {
          const y = 38 + index * 18
          return (
            <g key={row.key} transform={`translate(10, ${y})`}>
              <rect x={0} y={-8} width={8} height={8} rx={2} fill={row.color} />
              <text x={14} y={0} fontFamily="Arial" fontSize={11} fill={chartTheme.tooltipText}>
                {row.label}
              </text>
              <text
                x={tooltipWidth - 20}
                y={0}
                fontFamily="Arial"
                fontSize={11}
                fill={chartTheme.tooltipText}
                textAnchor="end"
              >
                {row.formattedValue}
              </text>
            </g>
          )
        })}
      </g>
    </g>
  )
}

type ValueScale = AxisScale<number>

function seriesValueScale(
  chartSeries: AreaChartSeries,
  yScale: ValueScale,
  yScaleRight: ValueScale | undefined
): ValueScale {
  return chartSeries.axis === 'right' && yScaleRight ? yScaleRight : yScale
}

/**
 * The lines, areas and sample circles. Memoised on its own: the tooltip
 * re-renders the chart on every pointer move, and this is the part whose
 * render builds a path string per drawn point.
 */
const SeriesPaths = React.memo(function SeriesPaths({
  series,
  xScale,
  yScale,
  yScaleRight,
  gradientId,
  compact,
  withPoints,
  xMax,
}: {
  series: (AreaChartSeries & { segments: MetricPoint[][] })[]
  xScale: AxisScale<number>
  yScale: ValueScale
  yScaleRight?: ValueScale
  gradientId: string
  compact: boolean
  withPoints: boolean
  xMax: number
}) {
  const isMultiSeries = series.length > 1
  const lineStrokeWidth = compact ? 1.35 : isMultiSeries ? 1.75 : 1.5
  const lineStrokeOpacity = compact ? 0.9 : 0.95
  const drawnPointCount = series.reduce(
    (count, chartSeries) => count + chartSeries.segments.reduce((sum, segment) => sum + segment.length, 0),
    0
  )
  const showPoints = withPoints && xMax > 0 && drawnPointCount <= xMax * MAX_POINT_MARKER_DENSITY

  return (
    <>
      {series.map((chartSeries) => {
        const valueScale = seriesValueScale(chartSeries, yScale, yScaleRight)
        const x = (d: MetricPoint) => xScale(getDate(d)) || 0
        const y = (d: MetricPoint) => valueScale(getValue(d)) || 0
        return chartSeries.segments.map((segment, index) => (
          <React.Fragment key={`${chartSeries.key}-${getDate(segment[0]).getTime()}-${index}`}>
            {!isMultiSeries && (
              <AreaClosed<MetricPoint>
                data={segment}
                x={x}
                y={y}
                yScale={valueScale}
                strokeWidth={compact ? 0 : 1}
                stroke={compact ? 'transparent' : `url(#${gradientId})`}
                fill={`url(#${gradientId})`}
                curve={curveMonotoneX}
              />
            )}
            <LinePath<MetricPoint>
              curve={curveMonotoneX}
              data={segment}
              x={x}
              y={y}
              stroke={chartSeries.color}
              strokeWidth={lineStrokeWidth}
              strokeOpacity={lineStrokeOpacity}
              shapeRendering={compact ? 'auto' : 'geometricPrecision'}
            />
            {showPoints &&
              segment.map((d, j) => (
                <circle
                  key={j}
                  r={2}
                  cx={x(d)}
                  cy={y(d)}
                  stroke={chartSeries.color}
                  strokeOpacity={0.85}
                  fill="transparent"
                />
              ))}
          </React.Fragment>
        ))
      })}
    </>
  )
})

export function AreaChart({
  series,
  gradientColor,
  width,
  yMax,
  margin,
  xScale,
  yScale,
  yScaleRight,
  hideBottomAxis = false,
  hideLeftAxis = false,
  hideRightAxis = false,
  hideGrid = false,
  withPoints = true,
  gapThresholdMs = null,
  showTooltip = false,
  chartTheme = metricChartThemes.dark,
  compact = false,
  top,
  left,
  children,
}: {
  series: AreaChartSeries[]
  gradientColor: string
  xScale: AxisScale<number>
  yScale: AxisScale<number>
  yScaleRight?: AxisScale<number>
  width: number
  yMax: number
  margin: { top: number; right: number; bottom: number; left: number }
  hideBottomAxis?: boolean
  hideLeftAxis?: boolean
  hideRightAxis?: boolean
  hideGrid?: boolean
  withPoints?: boolean
  gapThresholdMs?: number | null
  showTooltip?: boolean
  chartTheme?: MetricChartTheme
  compact?: boolean
  top?: number
  left?: number
  children?: React.ReactNode
}) {
  const ids = useId().replace(/:/g, '')
  const gradientId = `${ids}-gradient`
  const clipId = `${ids}-clip`
  const [tooltip, setTooltip] = useState<ChartTooltipState | null>(null)
  const xMax = Math.max(width - margin.left - margin.right, 0)
  const primaryColor = series[0]?.color ?? gradientColor
  const leftUnit = series.find((chartSeries) => chartSeries.axis !== 'right')?.unit
  const rightUnit = series.find((chartSeries) => chartSeries.axis === 'right')?.unit
  const hasRightAxis = Boolean(yScaleRight && series.some((chartSeries) => chartSeries.axis === 'right'))
  const gridTicks = useMemo(() => getScaleTicks(yScale, 5), [yScale])
  const axisBottomTickLabelProps = useMemo(
    () => ({ ...axisBottomTickLabelBaseProps, fill: chartTheme.axis }),
    [chartTheme.axis]
  )
  const axisLeftTickLabelProps = useMemo(
    () => ({ ...axisLeftTickLabelBaseProps, fill: chartTheme.axis }),
    [chartTheme.axis]
  )
  const axisRightTickLabelProps = useMemo(
    () => ({ ...axisRightTickLabelBaseProps, fill: chartTheme.axis }),
    [chartTheme.axis]
  )
  const seriesSegments = useMemo(
    () =>
      series.map((chartSeries) => ({
        ...chartSeries,
        segments: chartSeries.segments ?? splitByGap(chartSeries.data, gapThresholdMs),
      })),
    [series, gapThresholdMs]
  )
  // One snapshot per drawn timestamp, sorted by x, for the hover lookup.
  // Only the points inside the plot: the padding sample either side of the
  // window is drawn (clipped) so the line runs off the edge, but hovering
  // must not snap to it.
  const tooltipSnapshots = useMemo(() => {
    if (!showTooltip) {
      return []
    }
    const snapshots = new Map<number, ChartTooltipSnapshotAccumulator>()

    seriesSegments.forEach((chartSeries) => {
      const valueScale = seriesValueScale(chartSeries, yScale, yScaleRight)
      chartSeries.segments.forEach((segment) => {
        segment.forEach((point) => {
          const timestamp = getDate(point).getTime()
          const x = xScale(getDate(point))
          const value = getValue(point)
          const y = valueScale(value)

          if (
            !Number.isFinite(timestamp) ||
            typeof x !== 'number' ||
            !Number.isFinite(x) ||
            x < 0 ||
            x > xMax ||
            typeof y !== 'number' ||
            !Number.isFinite(y)
          ) {
            return
          }

          let snapshot = snapshots.get(timestamp)
          if (!snapshot) {
            snapshot = { timestamp, x, rowsByKey: new Map() }
            snapshots.set(timestamp, snapshot)
          }
          let row = snapshot.rowsByKey.get(chartSeries.key)
          if (!row) {
            row = {
              key: chartSeries.key,
              label: chartSeries.label,
              color: chartSeries.color,
              unit: chartSeries.unit,
              values: [],
              yValues: [],
            }
            snapshot.rowsByKey.set(chartSeries.key, row)
          }
          row.values.push(value)
          row.yValues.push(y)
        })
      })
    })

    return [...snapshots.values()]
      .map(
        (snapshot): ChartTooltipSnapshot => ({
          timestamp: snapshot.timestamp,
          x: snapshot.x,
          rows: [...snapshot.rowsByKey.values()].map((row) => ({
            key: row.key,
            label: row.label,
            color: row.color,
            formattedValue: formatMetricValueRange(row.values, row.unit),
            y: average(row.yValues),
          })),
        })
      )
      .sort((a, b) => a.x - b.x)
  }, [seriesSegments, showTooltip, xScale, yScale, yScaleRight, xMax])
  const areaFromOpacity = compact ? 0.1 : 0.28
  const areaToOpacity = compact ? 0 : 0.04

  const onTooltipPointerMove = (event: React.PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const snapshot = closestTooltipSnapshot(tooltipSnapshots, x)

    setTooltip(snapshot ? { ...snapshot, pointerY: y } : null)
  }

  if (width < 10) return null
  return (
    <Group left={left || margin.left} top={top || margin.top}>
      <LinearGradient
        id={gradientId}
        from={primaryColor}
        fromOpacity={areaFromOpacity}
        to={primaryColor}
        toOpacity={areaToOpacity}
      />
      <clipPath id={clipId}>
        {/* Headroom above and below: nice()d domains and stroke widths spill past yMax. */}
        <rect x={0} y={-8} width={xMax} height={yMax + 16} />
      </clipPath>
      {!hideGrid &&
        gridTicks.map((tick) => {
          const y = yScale(tick) || 0
          return <line key={tick} x1={0} x2={xMax} y1={y} y2={y} stroke={chartTheme.grid} strokeWidth={1} />
        })}
      <g clipPath={`url(#${clipId})`}>
        <SeriesPaths
          series={seriesSegments}
          xScale={xScale}
          yScale={yScale}
          yScaleRight={yScaleRight}
          gradientId={gradientId}
          compact={compact}
          withPoints={withPoints}
          xMax={xMax}
        />
      </g>
      {!hideBottomAxis && (
        <AxisBottom
          top={yMax}
          scale={xScale}
          numTicks={width > 520 ? 10 : 5}
          stroke={chartTheme.axis}
          tickStroke={chartTheme.axis}
          tickLabelProps={axisBottomTickLabelProps}
          tickFormat={formatAxisTimestamp}
        />
      )}
      {!hideLeftAxis && (
        <AxisLeft
          scale={yScale}
          numTicks={5}
          stroke={chartTheme.axis}
          tickStroke={chartTheme.axis}
          tickLabelProps={axisLeftTickLabelProps}
          tickFormat={(v: number) => formatMetricTick(v, leftUnit)}
        />
      )}
      {hasRightAxis && !hideRightAxis && yScaleRight && (
        <AxisRight
          left={xMax}
          scale={yScaleRight}
          numTicks={5}
          stroke={chartTheme.axis}
          tickStroke={chartTheme.axis}
          tickLabelProps={axisRightTickLabelProps}
          tickFormat={(v: number) => formatMetricTick(v, rightUnit)}
        />
      )}
      {children}
      {showTooltip && tooltipSnapshots.length > 0 && (
        <rect
          x={0}
          y={0}
          width={xMax}
          height={yMax}
          fill="transparent"
          pointerEvents="all"
          onPointerMove={onTooltipPointerMove}
          onPointerLeave={() => setTooltip(null)}
          style={{ cursor: compact ? 'default' : 'crosshair' }}
        />
      )}
      {showTooltip && tooltip && (
        <ChartTooltip tooltip={tooltip} xMax={xMax} yMax={yMax} chartTheme={chartTheme} compact={compact} />
      )}
    </Group>
  )
}
