import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { useRef, useState, useEffect } from 'react'
import { logsLogic } from './logsLogic'
import { insertBreaks } from '../../../../utils/insertBreaks'
import { frameLogic } from '../../frameLogic'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { Spinner } from '../../../../components/Spinner'
import { ArrowDownTrayIcon, ArrowUpTrayIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/solid'
import { workspaceLogic, type WorkspaceTheme } from '../../../workspace/workspaceLogic'

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

function terminalTextColor(theme: WorkspaceTheme): string {
  return theme === 'dark' ? 'text-white' : 'text-slate-950'
}

function metricNumberColor(
  value: number,
  warning: number,
  critical: number,
  lowerIsWorse = false,
  theme: WorkspaceTheme = 'dark'
): string {
  if (lowerIsWorse) {
    if (value <= critical) {
      return theme === 'dark' ? 'text-red-400' : 'text-red-700'
    }
    if (value <= warning) {
      return theme === 'dark' ? 'text-yellow-300' : 'text-amber-700'
    }
    return terminalTextColor(theme)
  }

  if (value >= critical) {
    return theme === 'dark' ? 'text-red-400' : 'text-red-700'
  }
  if (value >= warning) {
    return theme === 'dark' ? 'text-yellow-300' : 'text-amber-700'
  }
  return terminalTextColor(theme)
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

function metricEntryValueColor(key: string, value: unknown, theme: WorkspaceTheme): string {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return terminalTextColor(theme)
  }
  if (key === 'cpuTemperature') {
    return metricNumberColor(numericValue, 60, 75, false, theme)
  }
  if (key === 'cpuUsage' || key.endsWith('.percentage')) {
    return metricNumberColor(numericValue, 80, 95, false, theme)
  }
  if (key.startsWith('load[')) {
    return metricNumberColor(numericValue, 1, 2, false, theme)
  }
  return terminalTextColor(theme)
}

function renderMetricsLog(
  rest: Record<string, any>,
  expanded: boolean,
  onToggleExpanded: () => void,
  theme: WorkspaceTheme
): JSX.Element {
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
    <div className={theme === 'dark' ? 'text-gray-400' : 'text-slate-600'}>
      <span>
        <span className={theme === 'dark' ? 'text-yellow-600' : 'text-amber-700'}>metrics</span>{' '}
        {metricState && !hasStandardMetrics ? (
          <>
            <span
              className={
                metricState === 'error'
                  ? theme === 'dark'
                    ? 'text-red-300'
                    : 'text-red-700'
                  : terminalTextColor(theme)
              }
            >
              {metricState}
            </span>
            {typeof rest.error === 'string' ? (
              <span className={clsx('ml-2', theme === 'dark' ? 'text-red-200' : 'text-red-700')}>
                {insertBreaks(rest.error)}
              </span>
            ) : null}
          </>
        ) : (
          <>
            load{' '}
            {load.map((value, index) => (
              <span key={index} className={clsx(metricNumberColor(Number(value), 1, 2, false, theme), 'mr-2')}>
                {value}
              </span>
            ))}
            cpu{' '}
            <span className={metricNumberColor(cpuTemperature, 60, 75, false, theme)}>
              {cpuTemperature.toFixed(2)}°C
            </span>{' '}
            ram <span className={metricNumberColor(ramAvailablePercent, 15, 5, true, theme)}>{ramUsedMb}</span> /{' '}
            <span className={terminalTextColor(theme)}>{ramTotalMb} MB</span>
            {diskTotalBytes > 0 ? (
              <>
                {' '}
                disk{' '}
                <span className={metricNumberColor(diskAvailablePercent, 15, 5, true, theme)}>
                  {formatBytesInUnit(diskUsedBytes, diskUnitIndex)}
                </span>{' '}
                /{' '}
                <span className={terminalTextColor(theme)}>
                  {formatBytesInUnit(diskTotalBytes, diskUnitIndex)} {diskUnit}
                </span>
              </>
            ) : null}
          </>
        )}
        {entries.length > 0 ? (
          <button
            type="button"
            className={clsx(
              'ml-2 inline underline underline-offset-2 focus:outline-none focus:ring-1 focus:ring-blue-500',
              theme === 'dark' ? 'text-blue-300 hover:text-blue-100' : 'frameos-primary-text hover:underline'
            )}
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
              className={clsx(
                'inline-flex max-w-full items-center rounded border px-1.5',
                theme === 'dark' ? 'border-gray-800 bg-gray-950' : 'border-slate-200 bg-white/70'
              )}
            >
              <span className={clsx('mr-1 shrink-0', theme === 'dark' ? 'text-gray-500' : 'text-slate-500')}>
                {key}
              </span>
              <span className={clsx('min-w-0 break-all font-semibold', metricEntryValueColor(key, value, theme))}>
                {insertBreaks(formatMetricValue(key, value))}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface LogsProps {
  fullScreen?: boolean
  compact?: boolean
  className?: string
}

function logTypeClassName(type: string, theme: WorkspaceTheme): string {
  if (type === 'stdinfo') {
    return theme === 'dark' ? 'text-yellow-300' : 'text-amber-700'
  }
  if (type === 'stderr') {
    return theme === 'dark' ? 'text-red-300' : 'text-red-700'
  }
  if (type === 'agent') {
    return theme === 'dark' ? 'text-blue-300' : 'frameos-primary-text'
  }
  if (type === 'build') {
    return theme === 'dark' ? 'text-yellow-200' : 'text-amber-700'
  }
  return theme === 'dark' ? 'text-slate-100' : 'text-slate-900'
}

export function Logs({ fullScreen = false, compact = false, className }: LogsProps = {}) {
  const { frameId } = useValues(frameLogic)
  const { theme: workspaceTheme } = useValues(workspaceLogic)
  const { logs, filteredLogs, logSearch, logsLoading, fullLogDownloading } = useValues(logsLogic({ frameId }))
  const { downloadLog, downloadFullLog, setLogSearch } = useActions(logsLogic({ frameId }))
  const [atBottom, setAtBottom] = useState(true)
  const [expandedMetricLogIds, setExpandedMetricLogIds] = useState<number[]>([])
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const shouldStickToBottomRef = useRef(true)
  const renderTheme: WorkspaceTheme = fullScreen || compact ? workspaceTheme : 'dark'
  const searchActive = !compact && logSearch.trim().length > 0
  const visibleLogs = compact ? logs : filteredLogs
  const virtuosoKey = searchActive ? `search:${logSearch.trim()}` : 'all'

  const scrollListToAbsoluteEnd = (behavior: ScrollBehavior = 'auto') => {
    virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior })
    if (fullScreen && typeof window !== 'undefined') {
      const scrollElement = document.scrollingElement ?? document.documentElement
      window.scrollTo({ top: scrollElement.scrollHeight, behavior })
    }
  }

  const scrollListToAbsoluteEndAfterLayout = (behavior: ScrollBehavior = 'auto') => {
    if (typeof window === 'undefined') {
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollListToAbsoluteEnd(behavior))
    })
  }

  const scrollListToStartAfterLayout = (behavior: 'auto' | 'smooth' = 'auto') => {
    if (typeof window === 'undefined') {
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (fullScreen) {
          window.scrollTo({ top: 0, behavior })
        } else if (visibleLogs.length > 0) {
          virtuosoRef.current?.scrollToIndex({
            index: 0,
            align: 'start',
            behavior,
          })
        }
      })
    })
  }

  useEffect(() => {
    if (searchActive) {
      shouldStickToBottomRef.current = false
      scrollListToStartAfterLayout('auto')
      return
    }
    if (!shouldStickToBottomRef.current) {
      return
    }
    // wait for layout/measurement so large bursts keep us pinned
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (visibleLogs.length === 0) {
          return
        }
        virtuosoRef.current?.scrollToIndex({
          index: visibleLogs.length - 1,
          align: 'end',
          behavior: 'auto',
        })
        scrollListToAbsoluteEndAfterLayout('auto')
      })
    })
  }, [visibleLogs.length, logSearch])

  const scrollToLatest = (behavior: 'auto' | 'smooth' = 'smooth') => {
    if (visibleLogs.length === 0) {
      return
    }
    virtuosoRef.current?.scrollToIndex({ index: visibleLogs.length - 1, align: 'end', behavior })
    scrollListToAbsoluteEndAfterLayout(behavior)
  }

  const toggleMetricLogExpanded = (logId: number) => {
    setExpandedMetricLogIds((ids) => (ids.includes(logId) ? ids.filter((id) => id !== logId) : [...ids, logId]))
  }

  const menuItems = [
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
  ]

  return logsLoading ? (
    <div
      className={clsx(
        'frame-tool-panel flex h-full items-center justify-center text-sm frame-tool-muted',
        className,
        fullScreen ? 'min-h-[calc(100vh-3rem)]' : compact ? 'min-h-0 bg-transparent' : 'frame-tool-card rounded-[22px]'
      )}
    >
      Loading logs...
    </div>
  ) : (
    <div
      className={clsx(
        'frame-tool-panel @container relative',
        className,
        fullScreen
          ? ['min-h-[calc(100vh-3rem)] w-full', renderTheme === 'dark' ? 'text-slate-100' : 'text-slate-950']
          : compact
          ? [
              'h-full min-h-0 overflow-hidden bg-transparent',
              renderTheme === 'dark' ? 'text-slate-100' : 'text-slate-950',
            ]
          : 'frame-tool-terminal h-full overflow-hidden rounded-[22px] p-3'
      )}
    >
      {compact ? null : fullScreen ? (
        <DropdownMenu
          horizontal
          buttonColor="none"
          className="logs-menu-button-floating frameos-secondary-button flex h-10 w-10 items-center justify-center rounded-lg !px-0 !py-0"
          items={menuItems}
        />
      ) : (
        <DropdownMenu
          horizontal
          buttonColor="tertiary"
          className={visibleLogs.length > 0 ? 'absolute right-9 top-3 z-10' : 'absolute right-3 top-3 z-10'}
          items={menuItems}
        />
      )}
      {compact ? null : (
        <div
          className={clsx(
            'logs-filter-toolbar z-20 mb-4 flex items-center',
            fullScreen ? 'logs-filter-toolbar-floating gap-2' : 'flex-wrap gap-3 px-1 pb-2 pr-12'
          )}
        >
          <label
            className={clsx(
              'relative block min-w-0',
              fullScreen ? 'flex-1' : 'flex-[1_1_14rem] @md:max-w-2xl'
            )}
          >
            <span className="sr-only">Search logs</span>
            <MagnifyingGlassIcon
              className={clsx(
                'pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2',
                fullScreen ? 'left-2.5' : 'left-3',
                renderTheme === 'dark' ? 'text-slate-500' : 'text-slate-400'
              )}
            />
            <input
              value={logSearch}
              onChange={(event) => setLogSearch(event.target.value)}
              placeholder="Search logs..."
              className={clsx(
                'w-full rounded-full border font-sans text-sm shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400',
                fullScreen ? 'h-8 py-1.5 pl-8 pr-8' : 'h-10 py-2 pl-9 pr-10',
                renderTheme === 'dark'
                  ? 'border-white/10 bg-white/[0.04] text-slate-100 placeholder:text-slate-500'
                  : 'border-slate-200/80 bg-white/80 text-slate-950 placeholder:text-slate-400'
              )}
            />
            {searchActive ? (
              <button
                type="button"
                onClick={() => setLogSearch('')}
                className={clsx(
                  'absolute top-1/2 flex -translate-y-1/2 items-center justify-center rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                  fullScreen ? 'right-1 h-6 w-6' : 'right-1.5 h-7 w-7',
                  renderTheme === 'dark'
                    ? 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                    : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
                )}
                aria-label="Clear log search"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            ) : null}
          </label>
          <div
            className={clsx(
              'shrink-0 whitespace-nowrap font-sans text-xs font-semibold',
              renderTheme === 'dark' ? 'text-slate-400' : 'text-slate-500'
            )}
          >
            {searchActive ? `${visibleLogs.length} of ${logs.length} lines` : `${logs.length} lines`}
          </div>
        </div>
      )}
      <Virtuoso
        key={virtuosoKey}
        useWindowScroll={fullScreen}
        className={clsx(
          'overflow-x-hidden bg-transparent font-mono text-sm leading-5',
          fullScreen
            ? 'min-h-[calc(100vh-6rem)] w-full pr-14'
            : compact
            ? 'h-full min-h-0 pr-2'
            : 'h-full overflow-y-auto pr-2'
        )}
        ref={virtuosoRef}
        initialTopMostItemIndex={searchActive ? 0 : Math.max(visibleLogs.length - 1, 0)}
        data={visibleLogs}
        components={{
          Header: () => (fullScreen ? <div aria-hidden="true" className="logs-list-top-spacer" /> : null),
          Footer: () => (visibleLogs.length > 0 ? <div aria-hidden="true" className="h-5" /> : null),
          EmptyPlaceholder: () => (
            <div
              className={clsx(
                'flex h-full items-center justify-center',
                renderTheme === 'dark' ? 'text-gray-400' : 'text-slate-500'
              )}
            >
              {searchActive ? 'No matching logs' : 'No logs yet'}
            </div>
          ),
        }}
        followOutput={(isBottom) => (searchActive ? false : isBottom ? 'auto' : false)}
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
                logLine = renderMetricsLog(
                  rest,
                  expandedMetricLogIds.includes(log.id),
                  () => {
                    toggleMetricLogExpanded(log.id)
                  },
                  renderTheme
                )
              } else {
                logLine = (
                  <>
                    <span className={clsx('mr-2', renderTheme === 'dark' ? 'text-yellow-600' : 'text-amber-700')}>
                      {event}
                    </span>
                    {Object.entries(rest).map(([key, value]) => (
                      <span key={key} className="mr-2">
                        <span className={renderTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}>{key}=</span>
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
                <span className={renderTheme === 'dark' ? 'text-blue-300' : 'frameos-primary-text'}>{'[AGENT]'}</span>{' '}
                {logLine}
              </>
            )
          }

          return (
            <div
              key={log.id}
              className={clsx(
                'rounded-lg px-2 py-0.5 transition @md:flex @md:flex-row',
                logTypeClassName(log.type, renderTheme)
              )}
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
        <button
          type="button"
          onClick={() => scrollToLatest()}
          className={clsx(
            'frameos-secondary-button z-40 rounded-lg px-4 py-2 text-sm font-semibold shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            fullScreen ? 'fixed bottom-6 right-4 @4xl:right-8' : 'absolute bottom-5 right-6'
          )}
        >
          Scroll to latest
        </button>
      )}
    </div>
  )
}
