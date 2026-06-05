import { actions, afterMount, beforeUnmount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

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
  unit?: 'bytes' | 'percent' | 'pixels'
  data: MetricPoint[]
}

export interface TimeRange {
  start: number
  end: number
}

export interface RebootMarker {
  timestamp: Date
  logId?: string
  metricId?: string
  bootId?: string
  previousBootId?: string
}

interface MetricsResponseReboot {
  timestamp?: string
  log_id?: number | string
}

export type MetricsTimeRangePreset = '1h' | '6h' | '12h' | '24h' | '7d' | 'all' | 'custom'

export const metricsTimeRangeOptions: { value: MetricsTimeRangePreset; label: string }[] = [
  { value: '1h', label: 'Last 1h' },
  { value: '6h', label: 'Last 6h' },
  { value: '12h', label: 'Last 12h' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7d' },
  { value: 'all', label: 'All' },
]

export function metricSeriesVisibilityKey(category: string, seriesKey: string): string {
  return `${category}:${seriesKey}`
}

const DEFAULT_VISIBLE_MS = 60 * 60 * 1000
const HEADER_VISIBLE_MS = 60 * 60 * 1000
const MIN_VISIBLE_MS = 1000
const CURRENT_TIME_UPDATE_MS = 60 * 1000
const GAP_THRESHOLD_MULTIPLIER = 1.75
const MIN_GAP_CONNECTION_MS = 20 * 60 * 1000
const DEFAULT_TIME_RANGE_PRESET: MetricsTimeRangePreset = '1h'
const METRICS_TIME_RANGE_MS: Partial<Record<MetricsTimeRangePreset, number>> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
}
const SINGLE_SERIES_COLOR = 'var(--frameos-color-evergreen)'
const METRIC_SERIES_COLORS = [
  'var(--frameos-color-brass)',
  'var(--frameos-color-evergreen)',
  'var(--frameos-color-moss)',
  'color-mix(in srgb, var(--frameos-color-evergreen) 72%, var(--frameos-color-mist))',
  'color-mix(in srgb, var(--frameos-color-brass) 82%, var(--frameos-color-graphite))',
  'color-mix(in srgb, var(--frameos-color-moss) 74%, var(--frameos-color-graphite))',
]
const MEMORY_USAGE_COLORS: Record<string, string> = {
  total: 'var(--frameos-color-evergreen)',
  used: 'var(--frameos-color-brass)',
}
const DISK_USAGE_COLORS: Record<string, string> = {
  total: 'var(--frameos-color-evergreen)',
  used: 'var(--frameos-color-brass)',
}
const RUNTIME_DIMENSION_COLORS: Record<string, string> = {
  width: 'var(--frameos-color-evergreen)',
  height: 'var(--frameos-color-moss)',
}

function parseMetricTimestamp(timestamp: string): number {
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
  return Date.parse(hasTimeZone ? timestamp : `${timestamp}Z`)
}

function parseRebootMarker(marker: MetricsResponseReboot): RebootMarker | null {
  if (!marker.timestamp) {
    return null
  }
  const timestamp = parseMetricTimestamp(marker.timestamp)
  if (!Number.isFinite(timestamp)) {
    return null
  }
  return {
    timestamp: new Date(timestamp),
    logId: marker.log_id === undefined ? undefined : String(marker.log_id),
  }
}

function sortAndDedupeRebootMarkers(markers: RebootMarker[]): RebootMarker[] {
  const markersByKey = new Map<string, RebootMarker>()
  markers.forEach((marker) => {
    const timestamp = marker.timestamp.getTime()
    if (!Number.isFinite(timestamp)) {
      return
    }
    markersByKey.set(marker.logId ?? marker.metricId ?? String(timestamp), marker)
  })
  return [...markersByKey.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}

export function metricTimestamp(metric: MetricsType): number {
  return parseMetricTimestamp(metric.timestamp)
}

function metricBootId(metricValues: unknown): string | null {
  if (!metricValues || typeof metricValues !== 'object' || Array.isArray(metricValues)) {
    return null
  }
  const values = metricValues as Record<string, unknown>
  const runtime = values.runtime
  if (runtime && typeof runtime === 'object' && !Array.isArray(runtime)) {
    const runtimeValues = runtime as Record<string, unknown>
    const value = runtimeValues.bootId ?? runtimeValues.boot_id
    if (value !== undefined && value !== null) {
      return String(value)
    }
  }
  const value = values.bootId ?? values.boot_id
  return value === undefined || value === null ? null : String(value)
}

function metricRebootMarker(
  metric: MetricsType,
  bootId: string | null,
  previousBootId: string | null
): RebootMarker | null {
  const timestamp = metricTimestamp(metric)
  if (!Number.isFinite(timestamp)) {
    return null
  }

  const marker: RebootMarker = {
    timestamp: new Date(timestamp),
    metricId: String(metric.id),
  }
  const reboot = metric.metrics?.reboot
  if (reboot && typeof reboot === 'object' && !Array.isArray(reboot)) {
    const rebootValues = reboot as Record<string, unknown>
    const rebootBootId = rebootValues.bootId ?? rebootValues.boot_id
    const rebootPreviousBootId = rebootValues.previousBootId ?? rebootValues.previous_boot_id
    if (rebootBootId !== undefined && rebootBootId !== null) {
      marker.bootId = String(rebootBootId)
    }
    if (rebootPreviousBootId !== undefined && rebootPreviousBootId !== null) {
      marker.previousBootId = String(rebootPreviousBootId)
    }
  } else if (bootId !== null) {
    marker.bootId = bootId
    if (previousBootId !== null) {
      marker.previousBootId = previousBootId
    }
  }
  return marker
}

function rebootMarkersFromMetrics(metrics: MetricsType[]): RebootMarker[] {
  const markers: RebootMarker[] = []
  let previousBootId: string | null = null

  metrics.forEach((metric) => {
    const reboot = metric.metrics?.reboot
    const bootId = metricBootId(metric.metrics)
    const explicitReboot =
      reboot === true ||
      (Boolean(reboot) &&
        typeof reboot === 'object' &&
        !Array.isArray(reboot) &&
        Boolean((reboot as Record<string, unknown>).new))
    const bootChanged = bootId !== null && previousBootId !== null && bootId !== previousBootId
    if (explicitReboot || bootChanged) {
      const marker = metricRebootMarker(metric, bootId, previousBootId)
      if (marker) {
        markers.push(marker)
      }
    }
    if (bootId !== null) {
      previousBootId = bootId
    }
  })

  return sortAndDedupeRebootMarkers(markers)
}

function metricIntervalMs(metric: MetricsType): number | null {
  const interval = Number(metric.metrics?.intervalMs)
  return Number.isFinite(interval) && interval > 0 ? interval : null
}

function getMetricsDataTimeRange(metrics: MetricsType[]): TimeRange | null {
  const timestamps = metrics.map(metricTimestamp).filter(Number.isFinite)
  if (timestamps.length === 0) {
    return null
  }
  return normalizeTimeRange(Math.min(...timestamps), Math.max(...timestamps))
}

function getDefaultVisibleTimeRange(metrics: MetricsType[]): TimeRange | null {
  const timestamps = metrics.map(metricTimestamp).filter(Number.isFinite)
  if (timestamps.length === 0) {
    return null
  }

  const end = Math.max(...timestamps)
  return normalizeTimeRange(end - DEFAULT_VISIBLE_MS, end)
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

function timeRangeForPreset(timeRange: TimeRange | null, preset: MetricsTimeRangePreset): TimeRange | null {
  if (!timeRange) {
    return null
  }
  if (preset === 'all') {
    return timeRange
  }

  const visibleMs = METRICS_TIME_RANGE_MS[preset] ?? METRICS_TIME_RANGE_MS[DEFAULT_TIME_RANGE_PRESET]
  return normalizeTimeRange(timeRange.end - (visibleMs ?? DEFAULT_VISIBLE_MS), timeRange.end)
}

export function filterMetricsByCategoryAndTimeRange(
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
  unit?: MetricSeries['unit']
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

function normalizeDiskUsageEntries(value: Record<string, unknown>): [string, number][] {
  const total = Number(value.total)
  const used = Number(value.used)
  const available = Number(value.available)
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

function normalizeRuntimeDimensionEntries(value: Record<string, unknown>): [string, number][] {
  return ['width', 'height']
    .map((key): [string, number] => [key, Number(value[key])])
    .filter(([, value]) => Number.isFinite(value) && value > 0)
}

function formatShortBytes(value: number): string {
  const units = ['B', 'K', 'M', 'G', 'T']
  let unitIndex = 0
  let scaledValue = Math.max(0, value)

  while (scaledValue >= 1024 && unitIndex < units.length - 1) {
    scaledValue /= 1024
    unitIndex += 1
  }

  const rounded = unitIndex === 0 ? Math.round(scaledValue) : Math.round(scaledValue * 10) / 10
  const formatted = rounded >= 10 || unitIndex === 0 ? String(Math.round(rounded)) : rounded.toFixed(1)
  return `${formatted.replace(/\.0$/, '')}${units[unitIndex]}`
}

function formatShortBytesPair(used: number, total: number): string {
  const usedValue = formatShortBytes(used)
  const totalValue = formatShortBytes(total)
  const usedUnit = usedValue.match(/[A-Z]$/)?.[0]
  const totalUnit = totalValue.match(/[A-Z]$/)?.[0]

  if (usedUnit && totalUnit && usedUnit === totalUnit) {
    return `${usedValue.slice(0, -1)}/${totalValue}`
  }
  return `${usedValue}/${totalValue}`
}

function formatShortMetricNumber(value: number): string {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2)
}

function getLatestLoadSummary(metrics: MetricsType[]): string | null {
  for (let i = metrics.length - 1; i >= 0; i--) {
    const load = metrics[i].metrics?.load
    if (!Array.isArray(load)) {
      continue
    }

    const loadAverage = Number(load[0])
    if (Number.isFinite(loadAverage)) {
      return formatShortMetricNumber(loadAverage)
    }
  }

  return null
}

function getLatestUsageSummary(metrics: MetricsType[], category: 'memoryUsage' | 'diskUsage'): string | null {
  for (let i = metrics.length - 1; i >= 0; i--) {
    const usage = metrics[i].metrics?.[category]
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
      continue
    }

    const usageRecord = usage as Record<string, unknown>
    const total = Number(usageRecord.total)
    const used = Number(usageRecord.used)
    const available = Number(usageRecord.available ?? usageRecord.free)
    const resolvedUsed =
      Number.isFinite(used) || !Number.isFinite(total) || !Number.isFinite(available)
        ? used
        : Math.max(0, total - available)

    if (Number.isFinite(total) && total > 0 && Number.isFinite(resolvedUsed)) {
      return formatShortBytesPair(resolvedUsed, total)
    }
  }

  return null
}

function getLatestRuntimeDimensionsSummary(metrics: MetricsType[]): string | null {
  for (let i = metrics.length - 1; i >= 0; i--) {
    const runtime = metrics[i].metrics?.runtime
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
      continue
    }

    const runtimeRecord = runtime as Record<string, unknown>
    const width = Number(runtimeRecord.width)
    const height = Number(runtimeRecord.height)
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return `${width}x${height}`
    }
  }

  return null
}

export function metricsByCategoryFromMetrics(metrics: MetricsType[]): Record<string, MetricSeries[]> {
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
        const valueRecord = value as Record<string, unknown>
        if (key === 'runtime') {
          normalizeRuntimeDimensionEntries(valueRecord).forEach(([subKey, subValue]) => {
            const series = getOrCreateMetricSeries(
              metricsByCategory,
              'runtimeDimensions',
              `runtime.${subKey}`,
              subKey,
              RUNTIME_DIMENSION_COLORS[subKey] ?? metricSeriesColor(metricsByCategory.runtimeDimensions?.length ?? 0),
              'left',
              'pixels'
            )
            series.data.push({ x: timestamp, y: subValue })
          })
        }
        const entries =
          key === 'memoryUsage'
            ? normalizeMemoryUsageEntries(valueRecord)
            : key === 'diskUsage'
            ? normalizeDiskUsageEntries(valueRecord)
            : Object.entries(value)
        for (const [subKey, subValue] of entries) {
          if (
            (key === 'memoryUsage' && (subKey === 'active' || subKey === 'free' || subKey === 'percentage')) ||
            (key === 'diskUsage' && (subKey === 'filesystems' || subKey === 'percentage')) ||
            (key === 'processMemory' && subKey === 'pid') ||
            (key === 'runtime' && (subKey === 'width' || subKey === 'height'))
          ) {
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
                : key === 'diskUsage'
                ? getOrCreateMetricSeries(
                    metricsByCategory,
                    key,
                    fullSubKey,
                    subKey,
                    DISK_USAGE_COLORS[subKey] ?? metricSeriesColor(metricsByCategory[key]?.length ?? 0),
                    'left',
                    'bytes'
                  )
                : key === 'processMemory'
                ? getOrCreateMetricSeries(
                    metricsByCategory,
                    key,
                    fullSubKey,
                    subKey,
                    metricSeriesColor(metricsByCategory[key]?.length ?? 0),
                    'left',
                    'bytes'
                  )
                : getOrCreateMetricSeries(metricsByCategory, fullSubKey, fullSubKey, fullSubKey, SINGLE_SERIES_COLOR)
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
}

export function latestMetricSummariesByCategoryFromMetrics(metrics: MetricsType[]): Record<string, string> {
  const loadSummary = getLatestLoadSummary(metrics)
  const memoryUsageSummary = getLatestUsageSummary(metrics, 'memoryUsage')
  const diskUsageSummary = getLatestUsageSummary(metrics, 'diskUsage')
  const runtimeDimensionsSummary = getLatestRuntimeDimensionsSummary(metrics)
  return {
    ...(loadSummary ? { load: loadSummary } : {}),
    ...(memoryUsageSummary ? { memoryUsage: memoryUsageSummary } : {}),
    ...(diskUsageSummary ? { diskUsage: diskUsageSummary } : {}),
    ...(runtimeDimensionsSummary ? { runtimeDimensions: runtimeDimensionsSummary } : {}),
  }
}

export const metricsLogic = kea<metricsLogicType>([
  path(['src', 'scenes', 'frame', 'metricsLogic']),
  props({} as metricsLogicProps),
  connect(() => ({ logic: [socketLogic] })),
  key((props) => props.frameId),
  actions({
    setSelectedTimeRange: (start: number, end: number) => ({ start, end }),
    resetSelectedTimeRange: true,
    setSelectedTimeRangePreset: (preset: MetricsTimeRangePreset) => ({ preset }),
    setCurrentTime: (currentTime: number) => ({ currentTime }),
    toggleMetricSeries: (category: string, seriesKey: string) => ({ category, seriesKey }),
    requestMetrics: true,
    requestMetricsSuccess: true,
    requestMetricsFailure: (error: string) => ({ error }),
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
        setSelectedTimeRangePreset: () => null,
        loadMetricsSuccess: () => null,
      },
    ],
    selectedTimeRangePreset: [
      DEFAULT_TIME_RANGE_PRESET as MetricsTimeRangePreset,
      {
        setSelectedTimeRange: () => 'custom' as MetricsTimeRangePreset,
        resetSelectedTimeRange: () => DEFAULT_TIME_RANGE_PRESET,
        setSelectedTimeRangePreset: (_, { preset }) => preset,
        loadMetricsSuccess: (state) => (state === 'custom' ? DEFAULT_TIME_RANGE_PRESET : state),
      },
    ],
    currentTime: [
      Date.now(),
      {
        setCurrentTime: (_, { currentTime }) => currentTime,
      },
    ],
    hiddenMetricSeries: [
      {} as Record<string, boolean>,
      {
        toggleMetricSeries: (state, { category, seriesKey }) => {
          const key = metricSeriesVisibilityKey(category, seriesKey)
          const next = { ...state }
          if (next[key]) {
            delete next[key]
          } else {
            next[key] = true
          }
          return next
        },
      },
    ],
    requestMetricsLoading: [
      false,
      {
        requestMetrics: () => true,
        requestMetricsSuccess: () => false,
        requestMetricsFailure: () => false,
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
    logRebootMarkers: [
      [] as RebootMarker[],
      {
        [socketLogic.actionTypes.newLog]: (state, { log }) => {
          if (log.frame_id !== props.frameId) {
            return state
          }
          try {
            const payload = JSON.parse(log.line)
            if (payload.event === 'bootup') {
              const marker = parseRebootMarker({ timestamp: log.timestamp, log_id: log.id })
              return marker ? sortAndDedupeRebootMarkers([...state, marker]) : state
            }
          } catch (error) {}
          return state
        },
      },
    ],
  })),
  listeners(({ actions, props }) => ({
    requestMetrics: async () => {
      try {
        const response = await apiFetch(`/api/frames/${props.frameId}/event/metrics`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (!response.ok) {
          throw new Error('Failed to request metrics')
        }
        actions.requestMetricsSuccess()
      } catch (error) {
        actions.requestMetricsFailure(error instanceof Error ? error.message : 'Failed to request metrics')
      }
    },
  })),
  selectors({
    sortedMetrics: [
      (s) => [s.metrics],
      (metrics) => [...metrics].sort((a, b) => metricTimestamp(a) - metricTimestamp(b)),
    ],
    metricRebootMarkers: [(s) => [s.sortedMetrics], (metrics) => rebootMarkersFromMetrics(metrics)],
    rebootMarkers: [
      (s) => [s.metricRebootMarkers, s.logRebootMarkers],
      (metricRebootMarkers, logRebootMarkers) =>
        sortAndDedupeRebootMarkers([...metricRebootMarkers, ...logRebootMarkers]),
    ],
    metricsTimeRange: [
      (s) => [s.sortedMetrics, s.currentTime],
      (metrics, currentTime): TimeRange | null => {
        const dataTimeRange = getMetricsDataTimeRange(metrics)
        if (!dataTimeRange) {
          return null
        }
        return normalizeTimeRange(dataTimeRange.start, Math.max(dataTimeRange.end, currentTime))
      },
    ],
    defaultSelectedTimeRange: [(s) => [s.sortedMetrics], (metrics) => getDefaultVisibleTimeRange(metrics)],
    headerMetricsTimeRange: [
      (s) => [s.metricsTimeRange],
      (metricsTimeRange) => trailingVisibleTimeRange(metricsTimeRange, HEADER_VISIBLE_MS),
    ],
    visibleTimeRange: [
      (s) => [s.selectedTimeRange, s.selectedTimeRangePreset, s.metricsTimeRange, s.defaultSelectedTimeRange],
      (selectedTimeRange, selectedTimeRangePreset, metricsTimeRange, defaultSelectedTimeRange): TimeRange | null => {
        if (!metricsTimeRange || !defaultSelectedTimeRange) {
          return null
        }
        return selectedTimeRange
          ? clampTimeRange(selectedTimeRange, metricsTimeRange, defaultSelectedTimeRange)
          : timeRangeForPreset(metricsTimeRange, selectedTimeRangePreset) ?? defaultSelectedTimeRange
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
        return Math.max(interval ? interval * GAP_THRESHOLD_MULTIPLIER : 0, MIN_GAP_CONNECTION_MS)
      },
    ],
    metricsByCategory: [
      (s) => [s.sortedMetrics],
      (metrics) => metricsByCategoryFromMetrics(metrics),
    ],
    headerMetricsByCategory: [
      (s) => [s.metricsByCategory, s.headerMetricsTimeRange],
      (metricsByCategory, headerMetricsTimeRange) =>
        filterMetricsByCategoryAndTimeRange(
          metricsByCategory,
          ['load', 'memoryUsage', 'diskUsage'],
          headerMetricsTimeRange
        ),
    ],
    visibleMetricsByCategory: [
      (s) => [s.metricsByCategory, s.hiddenMetricSeries],
      (metricsByCategory, hiddenMetricSeries): Record<string, MetricSeries[]> =>
        Object.fromEntries(
          Object.entries(metricsByCategory).map(([category, series]) => [
            category,
            series.filter((chartSeries) => !hiddenMetricSeries[metricSeriesVisibilityKey(category, chartSeries.key)]),
          ])
        ),
    ],
    latestMetricSummariesByCategory: [
      (s) => [s.sortedMetrics],
      (metrics): Record<string, string> => latestMetricSummariesByCategoryFromMetrics(metrics),
    ],
  }),
  afterMount(({ actions, cache }) => {
    actions.loadMetrics()
    actions.setCurrentTime(Date.now())
    cache.currentTimeInterval = window.setInterval(() => actions.setCurrentTime(Date.now()), CURRENT_TIME_UPDATE_MS)
  }),
  beforeUnmount(({ cache }) => {
    if (cache.currentTimeInterval) {
      window.clearInterval(cache.currentTimeInterval)
      cache.currentTimeInterval = null
    }
  }),
])
