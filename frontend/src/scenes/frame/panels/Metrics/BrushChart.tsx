import React, { useRef, useState, useMemo } from 'react'
import { scaleTime, scaleLinear } from '@visx/scale'
import { Brush } from '@visx/brush'
import { Bounds } from '@visx/brush/lib/types'
import BaseBrush from '@visx/brush/lib/BaseBrush'
import { PatternLines } from '@visx/pattern'
import { Group } from '@visx/group'
import { max, extent } from '@visx/vendor/d3-array'
import { BrushHandleRenderProps } from '@visx/brush/lib/BrushHandle'
import { AreaChart } from './AreaChart'
import { WithParentSizeProps } from '@visx/responsive/lib/enhancers/withParentSize'

// Initialize some variables
const brushMargin = { top: 10, bottom: 15, left: 50, right: 20 }
const chartSeparation = 30
const PATTERN_ID = 'brush_pattern'
const GRADIENT_ID = 'brush_gradient'
export const accentColor = '#f6acc8'
export const background2 = '#4c507a'
const selectedBrushStyle = {
  fill: `url(#${PATTERN_ID})`,
  stroke: 'white',
}

// accessors
const getDate = (m: { x: Date; y: number }) => m.x
const getValue = (m: { x: Date; y: number }) => m.y

export type BrushProps = {
  width: number
  height: number
  margin?: { top: number; right: number; bottom: number; left: number }
  compact?: boolean
  data: { x: Date; y: number }[]
}

const getInitialBounds = (data: { x: Date; y: number }[]) => {
  const last =
    data.length > 0 ? Math.min(getDate(data[data?.length - 1]).getTime(), new Date().getTime()) : new Date().getTime()
  const first = data.length > 0 ? Math.max(getDate(data[0]).getTime(), last - 3600000) : last - 3600000
  return [first, last]
}

export function BrushChart({
  compact = false,
  width,
  height,
  data,
  margin = {
    top: 20,
    left: 40,
    bottom: 20,
    right: 20,
  },
}: BrushProps & WithParentSizeProps) {
  const brushRef = useRef<BaseBrush | null>(null)
  const [filteredData, setFilteredData] = useState(() => {
    const [min, max] = getInitialBounds(data)
    const filteredData = data.filter((d) => getDate(d).getTime() >= min && getDate(d).getTime() <= max)
    return filteredData
  })

  const innerHeight = height - margin.top - margin.bottom
  const topChartBottomMargin = compact ? chartSeparation / 2 : chartSeparation + 10
  const topChartHeight = 0.8 * innerHeight - topChartBottomMargin
  const bottomChartHeight = innerHeight - topChartHeight - chartSeparation

  // bounds
  const xMax = Math.max(width - margin.left - margin.right, 0)
  const yMax = Math.max(topChartHeight, 0)
  const xBrushMax = Math.max(width - brushMargin.left - brushMargin.right, 0)
  const yBrushMax = Math.max(bottomChartHeight - brushMargin.top - brushMargin.bottom, 0)

  // scales
  const dateScale = useMemo(
    () =>
      scaleTime<number>({
        range: [0, xMax],
        domain: extent(filteredData, getDate) as [Date, Date],
      }),
    [xMax, filteredData]
  )
  const valueScale = useMemo(
    () =>
      scaleLinear<number>({
        range: [yMax, 0],
        domain: [0, max(filteredData, getValue) || 0],
        nice: true,
      }),
    [yMax, filteredData]
  )
  const brushDateScale = useMemo(
    () =>
      scaleTime<number>({
        range: [0, xBrushMax],
        domain: extent(data, getDate) as [Date, Date],
      }),
    [xBrushMax]
  )
  const brushValueScale = useMemo(
    () =>
      scaleLinear({
        range: [yBrushMax, 0],
        domain: [0, max(data, getValue) || 0],
        nice: true,
      }),
    [yBrushMax]
  )

  const initialBrushPosition = useMemo(
    () => ({
      start: {
        x: brushDateScale(getInitialBounds(data)[0]),
      },
      end: {
        x: brushDateScale(getInitialBounds(data)[1]),
      },
    }),
    [brushDateScale]
  )

  const onBrushChange = (domain: Bounds | null) => {
    if (!domain) return
    const { x0, x1, y0, y1 } = domain
    const dataCopy = data.filter((s) => {
      const x = getDate(s).getTime()
      const y = getValue(s)
      return x > x0 && x < x1 && y > y0 && y < y1
    })
    setFilteredData(dataCopy)
  }

  return (
    <div>
      <svg width={width} height={height}>
        <rect x={0} y={0} width={width} height={height} fill={`url(#${GRADIENT_ID})`} rx={14} />
        <AreaChart
          hideBottomAxis={compact}
          data={filteredData}
          width={width}
          margin={{ ...margin, bottom: topChartBottomMargin }}
          yMax={yMax}
          xScale={dateScale}
          yScale={valueScale}
          gradientColor={background2}
        />
        <AreaChart
          hideBottomAxis
          hideLeftAxis
          data={data}
          width={width}
          yMax={yBrushMax}
          xScale={brushDateScale}
          yScale={brushValueScale}
          margin={brushMargin}
          top={topChartHeight + topChartBottomMargin + margin.top}
          gradientColor={background2}
          withPoints={false}
        >
          <PatternLines
            id={PATTERN_ID}
            height={8}
            width={8}
            stroke={accentColor}
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
            onClick={() => setFilteredData(data)}
            selectedBoxStyle={selectedBrushStyle}
            useWindowMoveEvents
            renderBrushHandle={(props) => <BrushHandle {...props} />}
          />
        </AreaChart>
      </svg>
    </div>
  )
}
// We need to manually offset the handles for them to be rendered at the right position
function BrushHandle({ x, height, isBrushActive }: BrushHandleRenderProps) {
  const pathWidth = 8
  const pathHeight = 15
  if (!isBrushActive) {
    return null
  }
  return (
    <Group left={x + pathWidth / 2} top={(height - pathHeight) / 2}>
      <path
        fill="#f2f2f2"
        d="M -4.5 0.5 L 3.5 0.5 L 3.5 15.5 L -4.5 15.5 L -4.5 0.5 M -1.5 4 L -1.5 12 M 0.5 4 L 0.5 12"
        stroke="#999999"
        strokeWidth="1"
        style={{ cursor: 'ew-resize' }}
      />
    </Group>
  )
}
