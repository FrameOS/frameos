import React, { useId, useMemo } from 'react'
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

// accessors
const getDate = (m: MetricPoint) => m.x
const getValue = (m: MetricPoint) => m.y

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
  withPoints = true,
  gapThresholdMs = null,
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
  withPoints?: boolean
  gapThresholdMs?: number | null
  top?: number
  left?: number
  children?: React.ReactNode
}) {
  const gradientId = useId().replace(/:/g, '')
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
  const isMultiSeries = series.length > 1

  if (width < 10) return null
  return (
    <Group left={left || margin.left} top={top || margin.top}>
      <LinearGradient id={gradientId} from={primaryColor} fromOpacity={0.28} to={primaryColor} toOpacity={0.04} />
      {gridTicks.map((tick) => {
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
    </Group>
  )
}
