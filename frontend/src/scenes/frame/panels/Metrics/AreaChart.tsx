import React, { useId, useMemo, useState } from 'react'
import { Group } from '@visx/group'
import { AreaClosed, LinePath } from '@visx/shape'
import { AxisLeft, AxisBottom, AxisRight, AxisScale } from '@visx/axis'
import { LinearGradient } from '@visx/gradient'
import { curveMonotoneX } from '@visx/curve'
import type { MetricPoint, MetricSeries } from './metricsLogic'

// Initialize some variables
const axisColor = 'rgba(244,244,245,0.78)'
const gridColor = 'rgba(244,244,245,0.1)'
const axisBottomTickLabelProps = {
  textAnchor: 'middle' as const,
  fontFamily: 'Arial',
  fontSize: 10,
  fill: axisColor,
}
const axisLeftTickLabelProps = {
  dx: '-0.25em',
  dy: '0.25em',
  fontFamily: 'Arial',
  fontSize: 10,
  textAnchor: 'end' as const,
  fill: axisColor,
}
const axisRightTickLabelProps = {
  dx: '0.25em',
  dy: '0.25em',
  fontFamily: 'Arial',
  fontSize: 10,
  textAnchor: 'start' as const,
  fill: axisColor,
}
const tooltipBackgroundColor = 'rgba(24,24,27,0.96)'
const tooltipBorderColor = 'rgba(244,244,245,0.24)'
const tooltipTextColor = 'rgba(244,244,245,0.92)'
const tooltipMutedTextColor = 'rgba(244,244,245,0.62)'
const tooltipShadowColor = 'rgba(0,0,0,0.24)'

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

function splitDataByGap(data: MetricPoint[], gapThresholdMs?: number | null): MetricPoint[][] {
  if (!gapThresholdMs || data.length <= 1) {
    return data.length === 0 ? [] : [data]
  }

  const segments: MetricPoint[][] = []
  let segment: MetricPoint[] = []

  data.forEach((point) => {
    const previous = segment[segment.length - 1]
    if (previous && getDate(point).getTime() - getDate(previous).getTime() > gapThresholdMs) {
      segments.push(segment)
      segment = []
    }
    segment.push(point)
  })

  if (segment.length > 0) {
    segments.push(segment)
  }

  return segments
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

function formatTooltipTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function closestTooltipSnapshot(snapshots: ChartTooltipSnapshot[], x: number): ChartTooltipSnapshot | null {
  let closest: ChartTooltipSnapshot | null = null
  let closestDistance = Infinity

  snapshots.forEach((snapshot) => {
    const distance = Math.abs(snapshot.x - x)
    if (distance < closestDistance) {
      closest = snapshot
      closestDistance = distance
    }
  })

  return closest
}

function ChartTooltip({ tooltip, xMax, yMax }: { tooltip: ChartTooltipState; xMax: number; yMax: number }) {
  const timeLabel = formatTooltipTimestamp(tooltip.timestamp)
  const widestRowLength = tooltip.rows.reduce(
    (length, row) => Math.max(length, row.label.length + row.formattedValue.length),
    timeLabel.length
  )
  const tooltipWidth = Math.min(Math.max(170, widestRowLength * 7 + 48), Math.max(170, xMax))
  const tooltipHeight = 32 + tooltip.rows.length * 18
  const rawLeft = tooltip.x + tooltipWidth + 12 <= xMax ? tooltip.x + 12 : tooltip.x - tooltipWidth - 12
  const left = Math.min(Math.max(rawLeft, 0), Math.max(xMax - tooltipWidth, 0))
  const top = Math.min(Math.max(tooltip.pointerY - tooltipHeight / 2, 0), Math.max(yMax - tooltipHeight, 0))

  return (
    <g pointerEvents="none">
      <line x1={tooltip.x} x2={tooltip.x} y1={0} y2={yMax} stroke={tooltipBorderColor} strokeWidth={1} />
      {tooltip.rows.map((row) => (
        <circle
          key={row.key}
          cx={tooltip.x}
          cy={row.y}
          r={4}
          fill={tooltipBackgroundColor}
          stroke={row.color}
          strokeWidth={1.5}
        />
      ))}
      <g transform={`translate(${left}, ${top})`}>
        <rect x={2} y={3} width={tooltipWidth} height={tooltipHeight} rx={6} fill={tooltipShadowColor} opacity={0.9} />
        <rect
          width={tooltipWidth}
          height={tooltipHeight}
          rx={6}
          fill={tooltipBackgroundColor}
          stroke={tooltipBorderColor}
        />
        <text x={10} y={19} fontFamily="Arial" fontSize={10} fill={tooltipMutedTextColor}>
          {timeLabel}
        </text>
        {tooltip.rows.map((row, index) => {
          const y = 38 + index * 18
          return (
            <g key={row.key} transform={`translate(10, ${y})`}>
              <rect x={0} y={-8} width={8} height={8} rx={2} fill={row.color} />
              <text x={14} y={0} fontFamily="Arial" fontSize={11} fill={tooltipTextColor}>
                {row.label}
              </text>
              <text
                x={tooltipWidth - 20}
                y={0}
                fontFamily="Arial"
                fontSize={11}
                fill={tooltipTextColor}
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
  top,
  left,
  children,
}: {
  series: MetricSeries[]
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
  top?: number
  left?: number
  children?: React.ReactNode
}) {
  const gradientId = useId().replace(/:/g, '')
  const [tooltip, setTooltip] = useState<ChartTooltipState | null>(null)
  const xMax = Math.max(width - margin.left - margin.right, 0)
  const primaryColor = series[0]?.color ?? gradientColor
  const leftUnit = series.find((chartSeries) => chartSeries.axis !== 'right')?.unit
  const rightUnit = series.find((chartSeries) => chartSeries.axis === 'right')?.unit
  const hasRightAxis = Boolean(yScaleRight && series.some((chartSeries) => chartSeries.axis === 'right'))
  const gridTicks = useMemo(() => getScaleTicks(yScale, 5), [yScale])
  const seriesSegments = useMemo(
    () =>
      series.map((chartSeries) => ({
        ...chartSeries,
        segments: splitDataByGap(chartSeries.data, gapThresholdMs),
      })),
    [series, gapThresholdMs]
  )
  const tooltipSnapshots = useMemo(() => {
    const snapshots = new Map<number, ChartTooltipSnapshotAccumulator>()

    series.forEach((chartSeries) => {
      chartSeries.data.forEach((point) => {
        const timestamp = getDate(point).getTime()
        const x = xScale(getDate(point))
        const value = getValue(point)
        const y = chartSeries.axis === 'right' && yScaleRight ? yScaleRight(value) : yScale(value)

        if (
          !Number.isFinite(timestamp) ||
          typeof x !== 'number' ||
          !Number.isFinite(x) ||
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
      .sort((a, b) => a.timestamp - b.timestamp)
  }, [series, xScale, yScale, yScaleRight])
  const isMultiSeries = series.length > 1

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
      <LinearGradient id={gradientId} from={primaryColor} fromOpacity={0.28} to={primaryColor} toOpacity={0.04} />
      {!hideGrid &&
        gridTicks.map((tick) => {
          const y = yScale(tick) || 0
          return <line key={tick} x1={0} x2={xMax} y1={y} y2={y} stroke={gridColor} strokeWidth={1} />
        })}
      {seriesSegments.map((chartSeries) =>
        chartSeries.segments.map((segment, index) => (
          <React.Fragment key={`${chartSeries.key}-${getDate(segment[0]).getTime()}-${index}`}>
            {!isMultiSeries && (
              <AreaClosed<MetricPoint>
                data={segment}
                x={(d) => xScale(getDate(d)) || 0}
                y={(d) =>
                  (chartSeries.axis === 'right' && yScaleRight ? yScaleRight(getValue(d)) : yScale(getValue(d))) || 0
                }
                yScale={chartSeries.axis === 'right' && yScaleRight ? yScaleRight : yScale}
                strokeWidth={1}
                stroke={`url(#${gradientId})`}
                fill={`url(#${gradientId})`}
                curve={curveMonotoneX}
              />
            )}
            <LinePath<MetricPoint>
              curve={curveMonotoneX}
              data={segment}
              x={(d) => xScale(getDate(d)) || 0}
              y={(d) =>
                (chartSeries.axis === 'right' && yScaleRight ? yScaleRight(getValue(d)) : yScale(getValue(d))) || 0
              }
              stroke={chartSeries.color}
              strokeWidth={isMultiSeries ? 1.75 : 1.5}
              strokeOpacity={0.95}
              shapeRendering="geometricPrecision"
              markerMid="url(#marker-circle)"
            />
          </React.Fragment>
        ))
      )}
      {withPoints &&
        series.map((chartSeries) =>
          chartSeries.data.map((d, j) => (
            <circle
              key={`${chartSeries.key}-${j}`}
              r={2}
              cx={xScale(getDate(d))}
              cy={(chartSeries.axis === 'right' && yScaleRight ? yScaleRight(getValue(d)) : yScale(getValue(d))) || 0}
              stroke={chartSeries.color}
              strokeOpacity={0.85}
              fill="transparent"
            />
          ))
        )}
      {!hideBottomAxis && (
        <AxisBottom
          top={yMax}
          scale={xScale}
          numTicks={width > 520 ? 10 : 5}
          stroke={axisColor}
          tickStroke={axisColor}
          tickLabelProps={axisBottomTickLabelProps}
        />
      )}
      {!hideLeftAxis && (
        <AxisLeft
          scale={yScale}
          numTicks={5}
          stroke={axisColor}
          tickStroke={axisColor}
          tickLabelProps={axisLeftTickLabelProps}
          tickFormat={(v: number) => formatMetricTick(v, leftUnit)}
        />
      )}
      {hasRightAxis && !hideRightAxis && yScaleRight && (
        <AxisRight
          left={xMax}
          scale={yScaleRight}
          numTicks={5}
          stroke={axisColor}
          tickStroke={axisColor}
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
          style={{ cursor: 'crosshair' }}
        />
      )}
      {showTooltip && tooltip && <ChartTooltip tooltip={tooltip} xMax={xMax} yMax={yMax} />}
    </Group>
  )
}
