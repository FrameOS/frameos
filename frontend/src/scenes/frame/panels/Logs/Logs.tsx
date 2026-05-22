import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { useRef, useState, useEffect } from 'react'
import { logsLogic } from './logsLogic'
import { insertBreaks } from '../../../../utils/insertBreaks'
import { frameLogic } from '../../frameLogic'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { Button } from '../../../../components/Button'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { frameSettingsLogic } from '../FrameSettings/frameSettingsLogic'
import { Spinner } from '../../../../components/Spinner'
import { ArrowDownTrayIcon, ArrowUpTrayIcon, ArrowPathIcon } from '@heroicons/react/24/solid'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'

function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  return `${date.getFullYear()}-${date.getMonth() + 1 < 10 ? '0' : ''}${date.getMonth() + 1}-${
    date.getDate() < 10 ? '0' : ''
  }${date.getDate()} ${date.getHours() < 10 ? '0' : ''}${date.getHours()}:${
    date.getMinutes() < 10 ? '0' : ''
  }${date.getMinutes()}:${date.getSeconds() < 10 ? '0' : ''}${date.getSeconds()}`
}

function toMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

function metricNumberColor(value: number, warning: number, critical: number, lowerIsWorse = false): string {
  if (lowerIsWorse) {
    if (value <= critical) {
      return 'text-red-400'
    }
    if (value <= warning) {
      return 'text-yellow-300'
    }
    return 'text-white'
  }

  if (value >= critical) {
    return 'text-red-400'
  }
  if (value >= warning) {
    return 'text-yellow-300'
  }
  return 'text-white'
}

interface MetricEntry {
  key: string
  value: unknown
}

function isMetricObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function flattenMetricEntries(metrics: Record<string, unknown>, prefix = ''): MetricEntry[] {
  return Object.entries(metrics).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => {
        const arrayKey = `${fullKey}[${index}]`
        return isMetricObject(item) ? flattenMetricEntries(item, arrayKey) : [{ key: arrayKey, value: item }]
      })
    }
    if (isMetricObject(value)) {
      return flattenMetricEntries(value, fullKey)
    }
    return [{ key: fullKey, value }]
  })
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value)
  }
  if (Number.isInteger(value)) {
    return String(value)
  }
  return value.toFixed(2).replace(/\.?0+$/, '')
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return String(bytes)
  }
  const units = ['B', 'KB', 'MB', 'GB']
  let unitIndex = 0
  let value = bytes
  while (Math.abs(value) >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${formatNumber(value)} ${units[unitIndex]}`
}

function formatBytesInUnit(bytes: number, unitIndex: number): string {
  return formatNumber(bytes / 1024 ** unitIndex)
}

function byteUnitIndex(bytes: number): number {
  const absBytes = Math.abs(bytes)
  if (absBytes >= 1024 * 1024 * 1024) {
    return 3
  }
  if (absBytes >= 1024 * 1024) {
    return 2
  }
  if (absBytes >= 1024) {
    return 1
  }
  return 0
}

function formatMetricValue(key: string, value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'number') {
    if (key === 'cpuTemperature') {
      return `${value.toFixed(2)}°C`
    }
    if (key === 'cpuUsage' || key.endsWith('.percentage')) {
      return `${formatNumber(value)}%`
    }
    if (key === 'intervalMs') {
      return `${formatNumber(value)} ms`
    }
    if (key.toLowerCase().includes('memory') || key.toLowerCase().includes('disk')) {
      return formatBytes(value)
    }
    return formatNumber(value)
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (value === undefined) {
    return 'undefined'
  }
  return JSON.stringify(value)
}

function metricEntryValueColor(key: string, value: unknown): string {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return 'text-white'
  }
  if (key === 'cpuTemperature') {
    return metricNumberColor(numericValue, 60, 75)
  }
  if (key === 'cpuUsage' || key.endsWith('.percentage')) {
    return metricNumberColor(numericValue, 80, 95)
  }
  if (key.startsWith('load[')) {
    return metricNumberColor(numericValue, 1, 2)
  }
  return 'text-white'
}

function renderMetricsLog(rest: Record<string, any>, expanded: boolean, onToggleExpanded: () => void): JSX.Element {
  const load = Array.isArray(rest.load) ? rest.load : [0, 0, 0]
  const cpuTemperature = Number(rest.cpuTemperature ?? 0)
  const memoryUsage = rest.memoryUsage ?? {}
  const diskUsage = rest.diskUsage ?? {}

  const ramTotalMb = toMb(Number(memoryUsage.total ?? 0))
  const ramAvailableBytes = Number(memoryUsage.available ?? memoryUsage.free ?? 0)
  const ramUsedBytes = Number(memoryUsage.used ?? Number(memoryUsage.total ?? 0) - ramAvailableBytes)
  const ramUsedMb = toMb(ramUsedBytes)
  const ramAvailableMb = Math.max(0, ramTotalMb - ramUsedMb)
  const ramAvailablePercent = ramTotalMb > 0 ? (ramAvailableMb / ramTotalMb) * 100 : 0
  const diskTotalBytes = Number(diskUsage.total ?? 0)
  const diskAvailableBytes = Number(diskUsage.available ?? diskUsage.free ?? 0)
  const diskUsedBytes = Number(diskUsage.used ?? diskTotalBytes - diskAvailableBytes)
  const diskUnitIndex = byteUnitIndex(diskTotalBytes)
  const diskUnit = ['B', 'KB', 'MB', 'GB'][diskUnitIndex]
  const diskAvailablePercent = diskTotalBytes > 0 ? ((diskTotalBytes - diskUsedBytes) / diskTotalBytes) * 100 : 0
  const entries = flattenMetricEntries(rest)
  const metricState = typeof rest.state === 'string' ? rest.state : null
  const hasStandardMetrics = 'load' in rest || 'cpuTemperature' in rest || 'memoryUsage' in rest || 'diskUsage' in rest

  return (
    <div className="text-gray-400">
      <span>
        <span className="text-yellow-600">metrics</span>{' '}
        {metricState && !hasStandardMetrics ? (
          <>
            <span className={metricState === 'error' ? 'text-red-300' : 'text-white'}>{metricState}</span>
            {typeof rest.error === 'string' ? (
              <span className="ml-2 text-red-200">{insertBreaks(rest.error)}</span>
            ) : null}
          </>
        ) : (
          <>
            load{' '}
            {load.map((value, index) => (
              <span key={index} className={clsx(metricNumberColor(Number(value), 1, 2), 'mr-2')}>
                {value}
              </span>
            ))}
            cpu <span className={metricNumberColor(cpuTemperature, 60, 75)}>{cpuTemperature.toFixed(2)}°C</span> ram{' '}
            <span className={metricNumberColor(ramAvailablePercent, 15, 5, true)}>{ramUsedMb}</span> /{' '}
            <span className="text-white">{ramTotalMb} MB</span>
            {diskTotalBytes > 0 ? (
              <>
                {' '}
                disk{' '}
                <span className={metricNumberColor(diskAvailablePercent, 15, 5, true)}>
                  {formatBytesInUnit(diskUsedBytes, diskUnitIndex)}
                </span>{' '}
                /{' '}
                <span className="text-white">
                  {formatBytesInUnit(diskTotalBytes, diskUnitIndex)} {diskUnit}
                </span>
              </>
            ) : null}
          </>
        )}
        {entries.length > 0 ? (
          <button
            type="button"
            className="ml-2 inline text-blue-300 underline underline-offset-2 hover:text-blue-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            aria-expanded={expanded}
            onClick={onToggleExpanded}
          >
            {expanded ? 'show less' : 'show all'}
          </button>
        ) : null}
      </span>
      {expanded ? (
        <div className="mt-1 flex flex-wrap gap-1.5 text-xs leading-5">
          {entries.map(({ key, value }) => (
            <span
              key={key}
              className="inline-flex max-w-full items-center rounded border border-gray-800 bg-gray-950 px-1.5"
            >
              <span className="mr-1 shrink-0 text-gray-500">{key}</span>
              <span className={clsx('min-w-0 break-all font-semibold', metricEntryValueColor(key, value))}>
                {insertBreaks(formatMetricValue(key, value))}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function Logs() {
  const inFrameAdminMode = isInFrameAdminMode()
  const { frameId } = useValues(frameLogic)
  const { logs, logsLoading, fullLogDownloading } = useValues(logsLogic({ frameId }))
  const { downloadLog, downloadFullLog } = useActions(logsLogic({ frameId }))
  const [atBottom, setAtBottom] = useState(true)
  const [expandedMetricLogIds, setExpandedMetricLogIds] = useState<number[]>([])
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const shouldStickToBottomRef = useRef(true)
  const { buildCacheLoading } = useValues(frameSettingsLogic({ frameId }))
  const { clearBuildCache } = useActions(frameSettingsLogic({ frameId }))

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return
    }
    // wait for layout/measurement so large bursts keep us pinned
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: logs.length - 1,
          align: 'end',
          behavior: 'auto',
        })
      })
    })
  }, [logs.length])

  const toggleMetricLogExpanded = (logId: number) => {
    setExpandedMetricLogIds((ids) => (ids.includes(logId) ? ids.filter((id) => id !== logId) : [...ids, logId]))
  }

  return logsLoading ? (
    <div className="frame-tool-panel frame-tool-card flex h-full items-center justify-center rounded-[22px] text-sm frame-tool-muted">
      Loading logs...
    </div>
  ) : (
    <div className="frame-tool-panel frame-tool-terminal relative h-full overflow-hidden rounded-[22px] p-3">
      <DropdownMenu
        horizontal
        buttonColor="tertiary"
        className={logs.length > 0 ? 'absolute right-9 top-3 z-10' : 'absolute right-3 top-3 z-10'}
        items={[
          {
            label: 'Download log',
            onClick: downloadLog,
            icon: <ArrowUpTrayIcon className="w-5 h-5" />,
          },
          {
            label: 'Download full log',
            onClick: downloadFullLog,
            icon: fullLogDownloading ? (
              <Spinner color="white" className="w-4 h-4" />
            ) : (
              <ArrowDownTrayIcon className="w-5 h-5" />
            ),
            loading: fullLogDownloading,
          },
          ...(!inFrameAdminMode
            ? [
                {
                  label: 'Clear build cache on frame',
                  onClick: () => {
                    clearBuildCache()
                  },
                  icon: buildCacheLoading ? (
                    <Spinner color="white" className="w-4 h-4" />
                  ) : (
                    <ArrowPathIcon className="w-5 h-5" />
                  ),
                },
              ]
            : []),
        ]}
      />
      <Virtuoso
        className="h-full overflow-y-scroll overflow-x-hidden bg-transparent pr-2 font-mono text-sm leading-5"
        ref={virtuosoRef}
        initialTopMostItemIndex={logs.length - 1}
        data={logs}
        components={{
          EmptyPlaceholder: () => (
            <div className="text-gray-400 h-full flex items-center justify-center">No logs yet</div>
          ),
        }}
        followOutput={(isBottom) => (isBottom ? 'auto' : false)}
        atBottomStateChange={(bottom) => {
          shouldStickToBottomRef.current = bottom
          setAtBottom(bottom)
        }}
        atBottomThreshold={200}
        increaseViewportBy={{ top: 0, bottom: 600 }}
        itemContent={(index, log) => {
          let logLine: string | JSX.Element = String(log.line)
          if (log.type === 'webhook') {
            try {
              const { event, timestamp, ...rest } = JSON.parse(log.line)
              if (event === 'metrics') {
                logLine = renderMetricsLog(rest, expandedMetricLogIds.includes(log.id), () => {
                  toggleMetricLogExpanded(log.id)
                })
              } else {
                logLine = (
                  <>
                    <span className="text-yellow-600 mr-2">{event}</span>
                    {Object.entries(rest).map(([key, value]) => (
                      <span key={key} className="mr-2">
                        <span className="text-gray-400">{key}=</span>
                        <span>{insertBreaks(JSON.stringify(value))}</span>
                      </span>
                    ))}
                  </>
                )
              }
            } catch (e) {}
          } else if (log.type === 'agent') {
            logLine = (
              <>
                <span className="text-blue-600">{'[AGENT]'}</span> {logLine}
              </>
            )
          }

          return (
            <div
              key={log.id}
              className={clsx('rounded-lg px-2 py-0.5 transition sm:flex sm:flex-row', {
                'text-yellow-300': log.type === 'stdinfo',
                'text-red-300': log.type === 'stderr',
                'text-blue-300': log.type === 'agent',
                'text-yellow-200': log.type === 'build',
              })}
            >
              <div className="flex-0 mr-3 whitespace-nowrap text-slate-500">{formatTimestamp(log.timestamp)}</div>
              <div className="flex-1 break-words" style={{ wordBreak: 'break-word' }}>
                {logLine}
              </div>
            </div>
          )
        }}
      />
      {!atBottom && (
        <Button
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: logs.length - 1, behavior: 'smooth' })}
          color="secondary"
          size="small"
          className="absolute bottom-4 right-6"
        >
          Scroll to latest
        </Button>
      )}
    </div>
  )
}
