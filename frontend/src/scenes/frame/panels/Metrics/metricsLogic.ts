import { actions, afterMount, connect, kea, key, path, props, reducers, selectors } from 'kea'

import { MetricsType } from '../../../../types'
import { loaders } from 'kea-loaders'
import { socketLogic } from '../../../socketLogic'

import type { metricsLogicType } from './metricsLogicType'
import { apiFetch } from '../../../../utils/apiFetch'

export interface metricsLogicProps {
  frameId: number
}

export interface MetricPoint {
  x: Date
  y: number
}

export interface MetricSeries {
  key: string
  label: string
  color: string
  axis: 'left' | 'right'
  unit?: 'bytes' | 'percent'
  data: MetricPoint[]
}

export interface TimeRange {
  start: number
  end: number
}

const DEFAULT_VISIBLE_MS = 4 * 60 * 60 * 1000
const HEADER_VISIBLE_MS = 60 * 60 * 1000
const MIN_VISIBLE_MS = 1000
const GAP_THRESHOLD_MULTIPLIER = 1.75
const SINGLE_SERIES_COLOR = '#2dd4bf'
const METRIC_SERIES_COLORS = ['#f59e0b', '#38bdf8', '#a78bfa', '#34d399', '#fb7185', '#f472b6']
const MEMORY_USAGE_COLORS: Record<string, string> = {
  total: '#38bdf8',
  used: '#fb7185',
}

function parseMetricTimestamp(timestamp: string): number {
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
  return Date.parse(hasTimeZone ? timestamp : `${timestamp}Z`)
}

function metricTimestamp(metric: MetricsType): number {
  return parseMetricTimestamp(metric.timestamp)
}

function metricIntervalMs(metric: MetricsType): number | null {
  const interval = Number(metric.metrics?.intervalMs)
  return Number.isFinite(interval) && interval > 0 ? interval : null
}

function normalizeTimeRange(start: number, end: number): TimeRange {
  const safeStart = Number.isFinite(start) ? start : Date.now() - DEFAULT_VISIBLE_MS
  const safeEnd = Number.isFinite(end) ? end : Date.now()
  const min = Math.min(safeStart, safeEnd)
  const max = Math.max(safeStart, safeEnd)

  if (max - min >= MIN_VISIBLE_MS) {
    return { start: min, end: max }
  }

  return { start: min - MIN_VISIBLE_MS / 2, end: max + MIN_VISIBLE_MS / 2 }
}

function sameTimeRange(first: TimeRange | null, second: TimeRange | null): boolean {
  return first?.start === second?.start && first?.end === second?.end
}

function trailingVisibleTimeRange(timeRange: TimeRange | null, visibleMs: number): TimeRange | null {
  if (!timeRange) {
    return null
  }
  const end = timeRange.end
  const start = Math.max(timeRange.start, end - visibleMs)
  return normalizeTimeRange(start >= end ? end - visibleMs : start, end)
}

function defaultVisibleTimeRange(timeRange: TimeRange | null): TimeRange | null {
  return trailingVisibleTimeRange(timeRange, DEFAULT_VISIBLE_MS)
}

function filterMetricsByCategoryAndTimeRange(
  metricsByCategory: Record<string, MetricSeries[]>,
  categories: string[],
  timeRange: TimeRange | null
): Record<string, MetricSeries[]> {
  if (!timeRange) {
    return {}
  }

  return Object.fromEntries(
    categories
      .map((category) => {
        const series = metricsByCategory[category]
        if (!series) {
          return [category, []]
        }

        return [
          category,
          series
            .map((chartSeries) => ({
              ...chartSeries,
              data: chartSeries.data.filter((point) => {
                const timestamp = point.x.getTime()
                return timestamp >= timeRange.start && timestamp <= timeRange.end
              }),
            }))
            .filter((chartSeries) => chartSeries.data.length > 0),
        ]
      })
      .filter(([, series]) => (series as MetricSeries[]).length > 0)
  ) as Record<string, MetricSeries[]>
}

function clampTimeRange(range: TimeRange, timeRange: TimeRange, fallback: TimeRange): TimeRange {
  if (range.end < timeRange.start || range.start > timeRange.end) {
    return fallback
  }

  const start = Math.max(timeRange.start, range.start)
  const end = Math.min(timeRange.end, range.end)
  return start < end ? normalizeTimeRange(start, end) : fallback
}

function median(numbers: number[]): number | null {
  if (numbers.length === 0) {
    return null
  }
  const sorted = [...numbers].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function metricSeriesColor(index: number): string {
  return METRIC_SERIES_COLORS[index % METRIC_SERIES_COLORS.length]
}

function getOrCreateMetricSeries(
  metricsByCategory: Record<string, MetricSeries[]>,
  category: string,
  key: string,
  label: string,
  color: string,
  axis: 'left' | 'right' = 'left',
  unit?: 'bytes' | 'percent'
): MetricSeries {
  const categorySeries = (metricsByCategory[category] ||= [])
  let series = categorySeries.find((existingSeries) => existingSeries.key === key)
  if (!series) {
    series = { key, label, color, axis, unit, data: [] }
    categorySeries.push(series)
  }
  return series
}

function normalizeMemoryUsageEntries(value: Record<string, unknown>): [string, number][] {
  const total = Number(value.total)
  const used = Number(value.used)
  const available = Number(value.available ?? value.free)
  const entries: [string, number][] = []

  if (Number.isFinite(total)) {
    entries.push(['total', total])
  }
  if (Number.isFinite(used)) {
    entries.push(['used', used])
  } else if (Number.isFinite(total) && Number.isFinite(available)) {
    entries.push(['used', Math.max(0, total - available)])
  }

  return entries
}

export const metricsLogic = kea<metricsLogicType>([
  path(['src', 'scenes', 'frame', 'metricsLogic']),
  props({} as metricsLogicProps),
  connect(() => ({ logic: [socketLogic] })),
  key((props) => props.frameId),
  actions({
    setSelectedTimeRange: (start: number, end: number) => ({ start, end }),
    resetSelectedTimeRange: true,
  }),
  loaders(({ props }) => ({
    metrics: [
      [] as MetricsType[],
      {
        loadMetrics: async () => {
          try {
            const response = await apiFetch(`/api/frames/${props.frameId}/metrics`)
            if (!response.ok) {
              throw new Error('Failed to fetch logs')
            }
            const data = await response.json()
            return data.metrics as MetricsType[]
          } catch (error) {
            console.error(error)
            return []
          }
        },
      },
    ],
  })),
  reducers(({ props }) => ({
    selectedTimeRange: [
      null as TimeRange | null,
      {
        setSelectedTimeRange: (state, { start, end }) => {
          const next = normalizeTimeRange(start, end)
          return sameTimeRange(state, next) ? state : next
        },
        resetSelectedTimeRange: () => null,
        loadMetricsSuccess: () => null,
      },
    ],
    metrics: {
      [socketLogic.actionTypes.newLog]: (state, { log }) => {
        try {
          const { event, ...metrics } = JSON.parse(log.line)
          if (event === 'metrics' && log.frame_id === props.frameId) {
            return [...state, { frame_id: log.frame_id, id: String(log.id), timestamp: log.timestamp, metrics }]
          }
        } catch (error) {}
        return state
      },
    },
  })),
  selectors({
    sortedMetrics: [
      (s) => [s.metrics],
      (metrics) => [...metrics].sort((a, b) => metricTimestamp(a) - metricTimestamp(b)),
    ],
    metricsTimeRange: [
      (s) => [s.sortedMetrics],
      (metrics): TimeRange | null => {
        const timestamps = metrics.map(metricTimestamp).filter(Number.isFinite)
        if (timestamps.length === 0) {
          return null
        }
        return normalizeTimeRange(Math.min(...timestamps), Math.max(...timestamps))
      },
    ],
    defaultSelectedTimeRange: [
      (s) => [s.metricsTimeRange],
      (metricsTimeRange) => defaultVisibleTimeRange(metricsTimeRange),
    ],
    headerMetricsTimeRange: [
      (s) => [s.metricsTimeRange],
      (metricsTimeRange) => trailingVisibleTimeRange(metricsTimeRange, HEADER_VISIBLE_MS),
    ],
    visibleTimeRange: [
      (s) => [s.selectedTimeRange, s.metricsTimeRange, s.defaultSelectedTimeRange],
      (selectedTimeRange, metricsTimeRange, defaultSelectedTimeRange): TimeRange | null => {
        if (!metricsTimeRange || !defaultSelectedTimeRange) {
          return null
        }
        return selectedTimeRange
          ? clampTimeRange(selectedTimeRange, metricsTimeRange, defaultSelectedTimeRange)
          : defaultSelectedTimeRange
      },
    ],
    metricGapThresholdMs: [
      (s) => [s.sortedMetrics],
      (metrics): number | null => {
        const deltas: number[] = []
        const configuredIntervals: number[] = []
        for (let i = 1; i < metrics.length; i++) {
          const previous = metricTimestamp(metrics[i - 1])
          const next = metricTimestamp(metrics[i])
          const delta = next - previous
          if (Number.isFinite(delta) && delta > 0) {
            deltas.push(delta)
          }
        }
        metrics.forEach((metric) => {
          const interval = metricIntervalMs(metric)
          if (interval) {
            configuredIntervals.push(interval)
          }
        })
        const interval = median(configuredIntervals) ?? median(deltas)
        return interval ? interval * GAP_THRESHOLD_MULTIPLIER : null
      },
    ],
    metricsByCategory: [
      (s) => [s.sortedMetrics],
      (metrics) => {
        const metricsByCategory: Record<string, MetricSeries[]> = {}
        metrics.forEach((metric) => {
          const timestamp = new Date(metricTimestamp(metric))
          for (const [key, value] of Object.entries(metric.metrics)) {
            if (key === 'intervalMs') {
              continue
            }
            if (Array.isArray(value)) {
              for (let i = 0; i < value.length; i++) {
                const subKey = `${key}[${i}]`
                if (typeof value[i] === 'number') {
                  const series =
                    key === 'load'
                      ? getOrCreateMetricSeries(metricsByCategory, key, subKey, subKey, metricSeriesColor(i))
                      : getOrCreateMetricSeries(metricsByCategory, subKey, subKey, subKey, SINGLE_SERIES_COLOR)
                  series.data.push({ x: timestamp, y: value[i] })
                }
              }
            } else if (value && typeof value === 'object') {
              const entries =
                key === 'memoryUsage'
                  ? normalizeMemoryUsageEntries(value as Record<string, unknown>)
                  : Object.entries(value)
              for (const [subKey, subValue] of entries) {
                if (key === 'memoryUsage' && (subKey === 'active' || subKey === 'free' || subKey === 'percentage')) {
                  continue
                }
                if (typeof subValue === 'number') {
                  const fullSubKey = `${key}.${subKey}`
                  const series =
                    key === 'memoryUsage'
                      ? getOrCreateMetricSeries(
                          metricsByCategory,
                          key,
                          fullSubKey,
                          subKey,
                          MEMORY_USAGE_COLORS[subKey] ?? metricSeriesColor(metricsByCategory[key]?.length ?? 0),
                          'left',
                          'bytes'
                        )
                      : getOrCreateMetricSeries(
                          metricsByCategory,
                          fullSubKey,
                          fullSubKey,
                          fullSubKey,
                          SINGLE_SERIES_COLOR
                        )
                  series.data.push({ x: timestamp, y: subValue })
                }
              }
            } else if (typeof value === 'number') {
              const series = getOrCreateMetricSeries(metricsByCategory, key, key, key, SINGLE_SERIES_COLOR)
              series.data.push({ x: timestamp, y: value })
            }
          }
        })
        return metricsByCategory
      },
    ],
    headerMetricsByCategory: [
      (s) => [s.metricsByCategory, s.headerMetricsTimeRange],
      (metricsByCategory, headerMetricsTimeRange) =>
        filterMetricsByCategoryAndTimeRange(metricsByCategory, ['load', 'memoryUsage'], headerMetricsTimeRange),
    ],
  }),
  afterMount(({ actions, cache }) => {
    actions.loadMetrics()
  }),
])
