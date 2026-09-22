import type { FrameType, MetricsType } from '../types'

export interface FrameMetricAlert {
  key: string
  label: string
}

const USAGE_ALERT_PERCENT = 90
const CPU_TEMPERATURE_ALERT_C = 70
const OPEN_FILE_DESCRIPTORS_ALERT = 100
const DEFAULT_CPU_COUNT = 1
const DEFAULT_RUNTIME_CHECKPOINT_ALERT_MS = 10 * 60 * 1000
const MAX_RENDER_INTERVAL_RUNTIME_CHECKPOINT_ALERT_MS = 30 * 60 * 1000

function parseMetricTimestamp(timestamp: string): number {
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
  return Date.parse(hasTimeZone ? timestamp : `${timestamp}Z`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function latestMetricWithValue(metrics: MetricsType[], key: string): MetricsType | null {
  for (let i = metrics.length - 1; i >= 0; i--) {
    const metric = metrics[i]
    if (metric?.metrics?.[key] !== undefined) {
      return metric
    }
  }
  return null
}

function sortedMetrics(metrics: MetricsType[]): MetricsType[] {
  return [...metrics].sort(
    (first, second) => parseMetricTimestamp(first.timestamp) - parseMetricTimestamp(second.timestamp)
  )
}

function usagePercentage(value: unknown): number | null {
  if (!isRecord(value)) {
    return null
  }

  const percentage = finiteNumber(value.percentage)
  if (percentage !== null) {
    return percentage
  }

  const total = finiteNumber(value.total)
  const used = finiteNumber(value.used)
  const available = finiteNumber(value.available ?? value.free)
  const resolvedUsed = used ?? (total !== null && available !== null ? Math.max(0, total - available) : null)

  return total !== null && total > 0 && resolvedUsed !== null ? (resolvedUsed / total) * 100 : null
}

function diskUsageAlertLabel(value: unknown): string | null {
  const percentage = usagePercentage(value)
  if (percentage !== null && percentage > USAGE_ALERT_PERCENT) {
    return `Disk ${Math.round(percentage)}%`
  }

  if (!isRecord(value) || !Array.isArray(value.filesystems)) {
    return null
  }

  const failingFilesystem = value.filesystems
    .filter(isRecord)
    .map((filesystem) => ({
      mount: typeof filesystem.mount === 'string' ? filesystem.mount : null,
      percentage: usagePercentage(filesystem),
    }))
    .find((filesystem) => filesystem.percentage !== null && filesystem.percentage > USAGE_ALERT_PERCENT)

  return failingFilesystem?.percentage !== null && failingFilesystem?.percentage !== undefined
    ? `Disk ${failingFilesystem.mount ?? 'filesystem'} ${Math.round(failingFilesystem.percentage)}%`
    : null
}

function formatMegabytes(bytes: number): string {
  return `${Math.max(0, Math.round(bytes / (1024 * 1024)))} MB`
}

/**
 * The frame reports what its next upgrade needs free on the partition FrameOS
 * lives on (`diskUsage.upgradeHeadroom`, frameos/release_space.nim). A fixed
 * percentage cannot say this: on a 2 GB partition an upgrade is refused
 * at ~93%, so a 90% alert either cries wolf or arrives after the fact.
 */
function upgradeHeadroomAlertLabel(value: unknown): string | null {
  const headroom = isRecord(value) ? value.upgradeHeadroom : null
  if (!isRecord(headroom)) {
    return null
  }
  const needed = finiteNumber(headroom.needed)
  const available = finiteNumber(headroom.available)
  if (needed === null || available === null || needed <= 0 || available >= needed) {
    return null
  }
  return `No room for the next FrameOS update (${formatMegabytes(available)} free, ${formatMegabytes(needed)} needed)`
}

/** The frame's last `frameos upgrade`, if it failed (metrics.upgrade, frameos/metrics.nim). */
function failedUpgradeAlertLabel(value: unknown): string | null {
  if (!isRecord(value) || value.status !== 'failed') {
    return null
  }
  const version = typeof value.latest_version === 'string' ? ` to ${value.latest_version}` : ''
  const message = typeof value.message === 'string' && value.message ? `: ${value.message}` : ''
  return `FrameOS update${version} failed${message}`
}

function cpuCountFromMetric(metrics: Record<string, unknown>): number {
  const cpuCount =
    finiteNumber(metrics.cpuCount) ??
    finiteNumber(metrics.cpus) ??
    finiteNumber(metrics.cpu_count) ??
    finiteNumber(isRecord(metrics.cpu) ? metrics.cpu.count : null)
  return cpuCount !== null && cpuCount > 0 ? cpuCount : DEFAULT_CPU_COUNT
}

function runtimeCheckpointAlertMs(frame: FrameType): number {
  const metricsIntervalMs =
    Number.isFinite(frame.metrics_interval) && frame.metrics_interval > 0 ? frame.metrics_interval * 5 * 1000 : 0
  const renderIntervalMs =
    Number.isFinite(frame.interval) && frame.interval > 0
      ? Math.min(frame.interval * 2 * 1000, MAX_RENDER_INTERVAL_RUNTIME_CHECKPOINT_ALERT_MS)
      : 0

  return Math.max(DEFAULT_RUNTIME_CHECKPOINT_ALERT_MS, metricsIntervalMs, renderIntervalMs)
}

function formatDuration(ms: number): string {
  if (ms >= 60 * 60 * 1000) {
    return `${Math.round(ms / (60 * 60 * 1000))}h`
  }
  if (ms >= 60 * 1000) {
    return `${Math.round(ms / (60 * 1000))}m`
  }
  return `${Math.round(ms / 1000)}s`
}

export function getFrameMetricAlerts(frame: FrameType, metrics: MetricsType[]): FrameMetricAlert[] {
  const orderedMetrics = sortedMetrics(metrics)
  const alerts: FrameMetricAlert[] = []

  const memoryMetric = latestMetricWithValue(orderedMetrics, 'memoryUsage')
  const memoryPercentage = usagePercentage(memoryMetric?.metrics.memoryUsage)
  if (memoryPercentage !== null && memoryPercentage > USAGE_ALERT_PERCENT) {
    alerts.push({ key: 'memoryUsage', label: `Memory ${Math.round(memoryPercentage)}%` })
  }

  const diskMetric = latestMetricWithValue(orderedMetrics, 'diskUsage')
  const diskAlertLabel = diskUsageAlertLabel(diskMetric?.metrics.diskUsage)
  if (diskAlertLabel) {
    alerts.push({ key: 'diskUsage', label: diskAlertLabel })
  }
  const headroomAlertLabel = upgradeHeadroomAlertLabel(diskMetric?.metrics.diskUsage)
  if (headroomAlertLabel) {
    alerts.push({ key: 'diskUsage.upgradeHeadroom', label: headroomAlertLabel })
  }

  // The newest sample only: a failure the frame has since moved past (a later
  // attempt succeeded, or it was upgraded by hand) must not linger.
  const newestMetric = orderedMetrics[orderedMetrics.length - 1]
  const upgradeAlertLabel = failedUpgradeAlertLabel(newestMetric?.metrics?.upgrade)
  if (upgradeAlertLabel) {
    alerts.push({ key: 'upgrade', label: upgradeAlertLabel })
  }

  const cpuTemperatureMetric = latestMetricWithValue(orderedMetrics, 'cpuTemperature')
  const cpuTemperature = finiteNumber(cpuTemperatureMetric?.metrics.cpuTemperature)
  if (cpuTemperature !== null && cpuTemperature > CPU_TEMPERATURE_ALERT_C) {
    alerts.push({ key: 'cpuTemperature', label: `CPU temperature ${Math.round(cpuTemperature)}C` })
  }

  const loadMetric = latestMetricWithValue(orderedMetrics, 'load')
  const loadValue = Array.isArray(loadMetric?.metrics.load) ? finiteNumber(loadMetric?.metrics.load[0]) : null
  if (loadMetric && loadValue !== null) {
    const loadLimit = 2 * cpuCountFromMetric(loadMetric.metrics)
    if (loadValue > loadLimit) {
      alerts.push({ key: 'load', label: `Load ${loadValue.toFixed(2)} > ${loadLimit}` })
    }
  }

  const openFileDescriptorsMetric = latestMetricWithValue(orderedMetrics, 'openFileDescriptors')
  const openFileDescriptors = finiteNumber(openFileDescriptorsMetric?.metrics.openFileDescriptors)
  if (openFileDescriptors !== null && openFileDescriptors > OPEN_FILE_DESCRIPTORS_ALERT) {
    alerts.push({ key: 'openFileDescriptors', label: `Open files ${Math.round(openFileDescriptors)}` })
  }

  const runtimeMetric = latestMetricWithValue(orderedMetrics, 'runtime')
  const runtime = runtimeMetric?.metrics.runtime
  const checkpointAgeMs = isRecord(runtime) && runtime.active === true ? finiteNumber(runtime.checkpointAgeMs) : null
  if (checkpointAgeMs !== null) {
    const checkpointLimitMs = runtimeCheckpointAlertMs(frame)
    if (checkpointAgeMs > checkpointLimitMs) {
      alerts.push({
        key: 'runtime.checkpointAgeMs',
        label: `Runtime checkpoint ${formatDuration(checkpointAgeMs)} > ${formatDuration(checkpointLimitMs)}`,
      })
    }
  }

  return alerts
}

export function frameMetricAlertTitle(alerts: FrameMetricAlert[]): string {
  const [only] = alerts
  return alerts.length === 1 && only
    ? `Frame alert: ${only.label}`
    : `Frame alerts: ${alerts.map((alert) => alert.label).join(', ')}`
}
