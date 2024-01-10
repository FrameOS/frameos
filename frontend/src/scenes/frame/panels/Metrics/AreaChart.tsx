import React from 'react'
import { Group } from '@visx/group'
import { AreaClosed, LinePath } from '@visx/shape'
import { AxisLeft, AxisBottom, AxisScale } from '@visx/axis'
import { LinearGradient } from '@visx/gradient'
import { curveMonotoneY } from '@visx/curve'

// Initialize some variables
const axisColor = '#fff'
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

// accessors
const getDate = (m: { x: Date; y: number }) => m.x
const getValue = (m: { x: Date; y: number }) => m.y

export function AreaChart({
  data,
  gradientColor,
  width,
  yMax,
  margin,
  xScale,
  yScale,
  hideBottomAxis = false,
  hideLeftAxis = false,
  withPoints = true,
  top,
  left,
  children,
}: {
  data: { x: Date; y: number }[]
  gradientColor: string
  xScale: AxisScale<number>
  yScale: AxisScale<number>
  width: number
  yMax: number
  margin: { top: number; right: number; bottom: number; left: number }
  hideBottomAxis?: boolean
  hideLeftAxis?: boolean
  withPoints?: boolean
  top?: number
  left?: number
  children?: React.ReactNode
}) {
  if (width < 10) return null
  return (
    <Group left={left || margin.left} top={top || margin.top}>
      <LinearGradient id="gradient" from={gradientColor} fromOpacity={1} to={gradientColor} toOpacity={0.2} />
      <AreaClosed<{ x: Date; y: number }>
        data={data}
        x={(d) => xScale(getDate(d)) || 0}
        y={(d) => yScale(getValue(d)) || 0}
        yScale={yScale}
        strokeWidth={1}
        stroke="url(#gradient)"
        fill="url(#gradient)"
        curve={curveMonotoneY}
      />
      <LinePath<{ x: Date; y: number }>
        curve={curveMonotoneY}
        data={data}
        x={(d) => xScale(getDate(d)) || 0}
        y={(d) => yScale(getValue(d)) || 0}
        stroke="#fff"
        strokeWidth={1}
        strokeOpacity={0.5}
        shapeRendering="geometricPrecision"
        markerMid="url(#marker-circle)"
      />
      {withPoints &&
        data.map((d, j) => (
          <circle
            key={j}
            r={2}
            cx={xScale(getDate(d))}
            cy={yScale(getValue(d))}
            stroke="rgba(255,255,255,0.5)"
            fill="transparent"
          />
        ))}
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
          tickFormat={(v: number) =>
            v >= 1000000 ? `${Math.floor(v / 100000) / 10}M` : v >= 1000 ? `${Math.floor(v / 1000)}K` : String(v)
          }
        />
      )}
      {children}
    </Group>
  )
}
