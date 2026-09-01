import type { MetricPoint, MetricSeries, TimeRange } from './metricsLogic'

/**
 * Turning a metric series into something a chart can draw at a given
 * pixel width, without handing the SVG every sample ever recorded.
 *
 * Three steps, all pure and all on already time-sorted data:
 *
 * 1. Window: binary-search the visible time range out of the series, with
 *    one sample of padding on each side so the line runs off the edge of
 *    the plot instead of stopping at the last visible sample.
 * 2. Split: cut the window into runs at the gaps the sampling interval
 *    cannot explain, so a frame that slept for a day shows a hole rather
 *    than a line across it. This has to happen BEFORE downsampling — after
 *    it, two kept neighbours a bucket apart would look like a gap.
 * 3. Downsample: largest-triangle-three-buckets each run down to a budget
 *    of a couple of points per pixel. LTTB keeps the samples that shape the
 *    line (peaks, drops, the last point) and picks REAL samples, never
 *    averages, so the tooltip still shows values the frame reported.
 *
 * A 200 px wide chart and a 1600 px one get different point counts from the
 * same data; the caller passes the plot width in.
 */

export interface ChartSeries extends MetricSeries {
  /** Gap-split, downsampled runs of points, ready to draw. */
  segments: MetricPoint[][]
  /** How many samples fell inside the window before downsampling. */
  sampleCount: number
}

export interface PrepareChartSeriesOptions {
  /** The visible window; null draws the whole series. */
  timeRange: TimeRange | null
  /** The plot's width in CSS pixels, i.e. the x range of the scale. */
  pixelWidth: number
  /** Consecutive samples further apart than this are not joined. */
  gapThresholdMs?: number | null
  /** Drawn points per pixel of width, before LTTB kicks in. */
  pointsPerPixel?: number
}

const DEFAULT_POINTS_PER_PIXEL = 2
/** Below this many points there is nothing worth simplifying. */
const MIN_POINT_BUDGET = 16

const pointTime = (point: MetricPoint): number => point.x.getTime()

/** Index of the first point at or after `time` (binary search on sorted data). */
export function lowerBoundByTime(data: MetricPoint[], time: number): number {
  let low = 0
  let high = data.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (pointTime(data[mid]) < time) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return low
}

/** Index of the first point after `time` (binary search on sorted data). */
export function upperBoundByTime(data: MetricPoint[], time: number): number {
  let low = 0
  let high = data.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (pointTime(data[mid]) <= time) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return low
}

/**
 * The points inside `range`, plus `padding` neighbours on each side. Returns
 * the sorted slice and how many points were strictly inside the range.
 */
export function sliceByTimeRange(
  data: MetricPoint[],
  range: TimeRange,
  padding = 1
): { points: MetricPoint[]; insideCount: number } {
  const first = lowerBoundByTime(data, range.start)
  const end = upperBoundByTime(data, range.end)
  const insideCount = Math.max(0, end - first)
  if (insideCount === 0) {
    // Nothing inside — but a window between two samples still wants the
    // line drawn across it, so keep the neighbours if both exist.
    if (padding > 0 && first > 0 && first < data.length) {
      return { points: data.slice(first - 1, first + 1), insideCount: 0 }
    }
    return { points: [], insideCount: 0 }
  }
  return {
    points: data.slice(Math.max(0, first - padding), Math.min(data.length, end + padding)),
    insideCount,
  }
}

/** Cuts sorted points into runs wherever neighbours are further apart than the threshold. */
export function splitByGap(data: MetricPoint[], gapThresholdMs?: number | null): MetricPoint[][] {
  if (data.length === 0) {
    return []
  }
  if (!gapThresholdMs || data.length === 1) {
    return [data]
  }
  const segments: MetricPoint[][] = []
  let segmentStart = 0
  for (let i = 1; i < data.length; i++) {
    if (pointTime(data[i]) - pointTime(data[i - 1]) > gapThresholdMs) {
      segments.push(data.slice(segmentStart, i))
      segmentStart = i
    }
  }
  segments.push(data.slice(segmentStart))
  return segments
}

/**
 * Largest-Triangle-Three-Buckets (Steinarsson, 2013): keeps `threshold`
 * of the points — always the first and the last — choosing in each bucket
 * the point that forms the largest triangle with the previously kept point
 * and the next bucket's average. Input must be sorted by x.
 */
export function largestTriangleThreeBuckets(data: MetricPoint[], threshold: number): MetricPoint[] {
  const length = data.length
  if (threshold >= length) {
    return data
  }
  if (threshold < 3) {
    return [data[0], data[length - 1]]
  }

  const sampled: MetricPoint[] = new Array(threshold)
  const bucketSize = (length - 2) / (threshold - 2)
  let previousIndex = 0
  sampled[0] = data[0]

  for (let bucket = 0; bucket < threshold - 2; bucket++) {
    // Average of the next bucket, the far corner of every candidate triangle.
    let nextStart = Math.floor((bucket + 1) * bucketSize) + 1
    let nextEnd = Math.floor((bucket + 2) * bucketSize) + 1
    if (nextEnd > length) {
      nextEnd = length
    }
    if (nextStart >= nextEnd) {
      nextStart = nextEnd - 1
    }
    let averageX = 0
    let averageY = 0
    for (let i = nextStart; i < nextEnd; i++) {
      averageX += pointTime(data[i])
      averageY += data[i].y
    }
    const nextCount = nextEnd - nextStart
    averageX /= nextCount
    averageY /= nextCount

    // This bucket's candidates.
    const rangeStart = Math.floor(bucket * bucketSize) + 1
    const rangeEnd = Math.min(Math.floor((bucket + 1) * bucketSize) + 1, length - 1)
    const previousX = pointTime(data[previousIndex])
    const previousY = data[previousIndex].y

    let maxArea = -1
    let chosenIndex = rangeStart
    for (let i = rangeStart; i < rangeEnd; i++) {
      const area = Math.abs(
        (previousX - averageX) * (data[i].y - previousY) - (previousX - pointTime(data[i])) * (averageY - previousY)
      )
      if (area > maxArea) {
        maxArea = area
        chosenIndex = i
      }
    }
    sampled[bucket + 1] = data[chosenIndex]
    previousIndex = chosenIndex
  }

  sampled[threshold - 1] = data[length - 1]
  return sampled
}

/**
 * Downsamples every run to its share of the point budget, proportional to
 * how many samples it holds. A run with fewer samples than its share is
 * left alone; its spare budget is not redistributed, which keeps the sum
 * of drawn points under `budget` without a second pass.
 */
function downsampleSegments(segments: MetricPoint[][], budget: number): MetricPoint[][] {
  const total = segments.reduce((sum, segment) => sum + segment.length, 0)
  if (total <= budget) {
    return segments
  }
  return segments.map((segment) => {
    const share = Math.max(2, Math.floor((budget * segment.length) / total))
    return segment.length > share ? largestTriangleThreeBuckets(segment, share) : segment
  })
}

/** Windows, gap-splits and downsamples one series for a plot `pixelWidth` wide. */
export function prepareChartSeries(series: MetricSeries, options: PrepareChartSeriesOptions): ChartSeries {
  const { timeRange, pixelWidth, gapThresholdMs = null, pointsPerPixel = DEFAULT_POINTS_PER_PIXEL } = options
  const window = timeRange
    ? sliceByTimeRange(series.data, timeRange)
    : { points: series.data, insideCount: series.data.length }
  const budget = Math.max(MIN_POINT_BUDGET, Math.floor(Math.max(0, pixelWidth) * pointsPerPixel))
  const segments = downsampleSegments(splitByGap(window.points, gapThresholdMs), budget)
  return {
    ...series,
    data: segments.length === 1 ? segments[0] : segments.flat(),
    segments,
    sampleCount: window.insideCount,
  }
}

/** `prepareChartSeries` over a list, dropping series with nothing to draw. */
export function prepareChartSeriesList(series: MetricSeries[], options: PrepareChartSeriesOptions): ChartSeries[] {
  const prepared: ChartSeries[] = []
  for (const chartSeries of series) {
    const result = prepareChartSeries(chartSeries, options)
    if (result.data.length > 0) {
      prepared.push(result)
    }
  }
  return prepared
}

/** The same, for every category at once. */
export function prepareChartSeriesByCategory(
  seriesByCategory: Record<string, MetricSeries[]>,
  options: PrepareChartSeriesOptions
): Record<string, ChartSeries[]> {
  const result: Record<string, ChartSeries[]> = {}
  for (const [category, series] of Object.entries(seriesByCategory)) {
    result[category] = prepareChartSeriesList(series, options)
  }
  return result
}

/** All drawn points of a list of prepared series, optionally one axis only. */
export function flattenChartSeries(series: ChartSeries[], axis?: 'left' | 'right'): MetricPoint[] {
  const points: MetricPoint[] = []
  for (const chartSeries of series) {
    if (axis && chartSeries.axis !== axis) {
      continue
    }
    for (const segment of chartSeries.segments) {
      for (const point of segment) {
        points.push(point)
      }
    }
  }
  return points
}
