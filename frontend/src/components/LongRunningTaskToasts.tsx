import { useActions, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import { useEffect, useRef, type ReactNode } from 'react'
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DocumentTextIcon,
  DocumentArrowUpIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  PlayIcon,
  RocketLaunchIcon,
  ServerStackIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { framesModel } from '../models/framesModel'
import {
  LongRunningTask,
  LongRunningTaskKind,
  LongRunningTaskLog,
  longRunningTasksModel,
} from '../models/longRunningTasksModel'
import { frameHost } from '../decorators/frame'
import { Spinner } from './Spinner'
import { workspaceLogic, type WorkspaceTheme } from '../scenes/workspace/workspaceLogic'
import { insertBreaks } from '../utils/insertBreaks'
import { urls } from '../urls'

function taskIcon(kind: LongRunningTaskKind): JSX.Element {
  if (kind === 'deploy' || kind === 'agentDeploy') {
    return <RocketLaunchIcon className="h-5 w-5" />
  }
  if (kind === 'preview') {
    return <EyeIcon className="h-5 w-5" />
  }
  if (kind === 'render') {
    return <PlayIcon className="h-5 w-5" />
  }
  if (kind === 'activate') {
    return <PlayIcon className="h-5 w-5" />
  }
  if (kind === 'upload') {
    return <DocumentArrowUpIcon className="h-5 w-5" />
  }
  return <ServerStackIcon className="h-5 w-5" />
}

function formatTaskBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let scaled = Math.max(0, value)
  let unitIndex = 0
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024
    unitIndex += 1
  }
  const rounded = scaled >= 10 || unitIndex === 0 ? Math.round(scaled) : Math.round(scaled * 10) / 10
  return `${String(rounded).replace(/\.0$/, '')}${units[unitIndex]}`
}

function terminalTextColor(theme: WorkspaceTheme): string {
  return theme === 'dark' ? 'text-slate-100' : 'text-slate-900'
}

function metricNumberColor(
  value: number,
  warning: number,
  critical: number,
  lowerIsWorse = false,
  theme: WorkspaceTheme
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

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value)
  }
  if (Number.isInteger(value)) {
    return String(value)
  }
  return value.toFixed(2).replace(/\.?0+$/, '')
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

function toMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

function compactMetrics(rest: Record<string, any>): {
  load: unknown[]
  cpuTemperature: number
  ramTotalMb: number
  ramUsedMb: number
  ramAvailablePercent: number
  diskTotalBytes: number
  diskUsedBytes: number
  diskAvailablePercent: number
  diskUnitIndex: number
  diskUnit: string
  metricState: string | null
  hasStandardMetrics: boolean
} {
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
  const metricState = typeof rest.state === 'string' ? rest.state : null
  const hasStandardMetrics = 'load' in rest || 'cpuTemperature' in rest || 'memoryUsage' in rest || 'diskUsage' in rest

  return {
    load,
    cpuTemperature,
    ramTotalMb,
    ramUsedMb,
    ramAvailablePercent,
    diskTotalBytes,
    diskUsedBytes,
    diskAvailablePercent,
    diskUnitIndex,
    diskUnit,
    metricState,
    hasStandardMetrics,
  }
}

function formatCompactMetricsLine(rest: Record<string, any>): string {
  const metrics = compactMetrics(rest)

  if (metrics.metricState && !metrics.hasStandardMetrics) {
    return typeof rest.error === 'string'
      ? `metrics ${metrics.metricState} ${rest.error}`
      : `metrics ${metrics.metricState}`
  }

  const parts = [
    'metrics',
    'load',
    ...metrics.load.map(String),
    'cpu',
    `${metrics.cpuTemperature.toFixed(2)}°C`,
    'ram',
    `${metrics.ramUsedMb} / ${metrics.ramTotalMb} MB`,
  ]

  if (metrics.diskTotalBytes > 0) {
    parts.push(
      'disk',
      `${formatBytesInUnit(metrics.diskUsedBytes, metrics.diskUnitIndex)} / ${formatBytesInUnit(
        metrics.diskTotalBytes,
        metrics.diskUnitIndex
      )} ${metrics.diskUnit}`
    )
  }

  return parts.join(' ')
}

function taskTone(task: LongRunningTask, theme: WorkspaceTheme): string {
  if (theme === 'dark') {
    if (task.status === 'success') {
      return 'border-emerald-400/25 bg-emerald-950/90 text-emerald-50 shadow-black/35'
    }
    if (task.status === 'error') {
      return 'border-red-400/25 bg-red-950/90 text-red-50 shadow-black/35'
    }
    return 'border-white/10 bg-[#1d1f25]/95 text-slate-100 shadow-black/35'
  }

  if (task.status === 'success') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  }
  if (task.status === 'error') {
    return 'border-red-200 bg-red-50 text-red-800'
  }
  return 'border-slate-200 bg-white text-slate-800'
}

function taskIconTone(task: LongRunningTask, theme: WorkspaceTheme): string {
  if (theme === 'dark') {
    if (task.status === 'success') {
      return 'bg-emerald-400/12 text-emerald-200'
    }
    if (task.status === 'error') {
      return 'bg-red-400/12 text-red-200'
    }
    return 'bg-blue-400/12 text-blue-200'
  }

  if (task.status === 'success') {
    return 'bg-emerald-100 text-emerald-700'
  }
  if (task.status === 'error') {
    return 'bg-red-100 text-red-700'
  }
  return 'bg-blue-100 text-blue-700'
}

function taskStatusIcon(task: LongRunningTask, theme: WorkspaceTheme): JSX.Element {
  if (task.status === 'success') {
    return <CheckCircleIcon className={clsx('h-5 w-5', theme === 'dark' ? 'text-emerald-300' : 'text-emerald-600')} />
  }
  if (task.status === 'error') {
    return <ExclamationTriangleIcon className={clsx('h-5 w-5', theme === 'dark' ? 'text-red-300' : 'text-red-600')} />
  }
  return <Spinner className="h-4 w-4" />
}

function formatTaskLogLine(log: LongRunningTaskLog): string {
  if (log.type === 'webhook') {
    try {
      const { event, timestamp, ...rest } = JSON.parse(log.line)
      if (event === 'metrics') {
        return formatCompactMetricsLine(rest)
      }
      const details = Object.entries(rest)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ')
      return details ? `${event} ${details}` : event
    } catch (error) {}
  }
  if (log.type === 'status') {
    return log.line
  }
  if (log.type === 'stdout') {
    return log.line
  }
  return `[${log.type}] ${log.line}`
}

function taskLogTone(
  log: LongRunningTaskLog,
  formattedLine: string,
  theme: WorkspaceTheme
): { dot: string; timestamp: string } {
  const lowerLine = formattedLine.toLowerCase()

  if (
    log.type === 'stderr' ||
    lowerLine.includes('error') ||
    lowerLine.includes('failed') ||
    lowerLine.includes('traceback')
  ) {
    return theme === 'dark'
      ? { dot: 'bg-red-400', timestamp: 'text-red-300/80' }
      : { dot: 'bg-red-500', timestamp: 'text-red-600/80' }
  }

  if (lowerLine.includes('warn') || lowerLine.includes('retry')) {
    return theme === 'dark'
      ? { dot: 'bg-amber-300', timestamp: 'text-amber-200/80' }
      : { dot: 'bg-amber-500', timestamp: 'text-amber-600/80' }
  }

  if (
    lowerLine.includes('complete') ||
    lowerLine.includes('success') ||
    lowerLine.includes('ready') ||
    lowerLine.includes('updated') ||
    lowerLine.includes('deployed')
  ) {
    return theme === 'dark'
      ? { dot: 'bg-emerald-300', timestamp: 'text-emerald-200/80' }
      : { dot: 'bg-emerald-500', timestamp: 'text-emerald-600/80' }
  }

  if (log.type === 'status') {
    return theme === 'dark'
      ? { dot: 'bg-blue-300', timestamp: 'text-blue-200/80' }
      : { dot: 'bg-blue-500', timestamp: 'text-blue-600/80' }
  }

  if (log.type === 'webhook') {
    return { dot: 'frameos-log-webhook-dot', timestamp: 'frameos-log-webhook-timestamp' }
  }

  return theme === 'dark'
    ? { dot: 'bg-slate-500', timestamp: 'text-slate-500' }
    : { dot: 'bg-slate-400', timestamp: 'text-slate-500' }
}

function taskLogLineClassName(log: LongRunningTaskLog, formattedLine: string, theme: WorkspaceTheme): string {
  const lowerLine = formattedLine.toLowerCase()

  if (
    log.type === 'stderr' ||
    lowerLine.includes('error') ||
    lowerLine.includes('failed') ||
    lowerLine.includes('traceback')
  ) {
    return theme === 'dark' ? 'text-red-300' : 'text-red-700'
  }

  if (log.type === 'stdinfo' || log.type === 'build') {
    return theme === 'dark' ? 'text-yellow-300' : 'text-amber-700'
  }

  if (log.type === 'agent') {
    return theme === 'dark' ? 'text-blue-300' : 'frameos-primary-text'
  }

  return theme === 'dark' ? 'text-slate-100' : 'text-slate-900'
}

function renderTaskLogLine(log: LongRunningTaskLog, formattedLine: string, theme: WorkspaceTheme): ReactNode {
  if (log.type === 'webhook') {
    try {
      const { event, timestamp, ...rest } = JSON.parse(log.line)
      if (event === 'metrics') {
        const metrics = compactMetrics(rest)
        return (
          <span className={theme === 'dark' ? 'text-gray-400' : 'text-slate-600'}>
            <span className={theme === 'dark' ? 'text-yellow-600' : 'text-amber-700'}>metrics</span>{' '}
            {metrics.metricState && !metrics.hasStandardMetrics ? (
              <>
                <span
                  className={
                    metrics.metricState === 'error'
                      ? theme === 'dark'
                        ? 'text-red-300'
                        : 'text-red-700'
                      : terminalTextColor(theme)
                  }
                >
                  {metrics.metricState}
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
                {metrics.load.map((value, index) => (
                  <span key={index} className={clsx(metricNumberColor(Number(value), 1, 2, false, theme), 'mr-2')}>
                    {String(value)}
                  </span>
                ))}
                cpu{' '}
                <span className={metricNumberColor(metrics.cpuTemperature, 60, 75, false, theme)}>
                  {metrics.cpuTemperature.toFixed(2)}°C
                </span>{' '}
                ram{' '}
                <span className={metricNumberColor(metrics.ramAvailablePercent, 15, 5, true, theme)}>
                  {metrics.ramUsedMb}
                </span>{' '}
                / <span className={terminalTextColor(theme)}>{metrics.ramTotalMb} MB</span>
                {metrics.diskTotalBytes > 0 ? (
                  <>
                    {' '}
                    disk{' '}
                    <span className={metricNumberColor(metrics.diskAvailablePercent, 15, 5, true, theme)}>
                      {formatBytesInUnit(metrics.diskUsedBytes, metrics.diskUnitIndex)}
                    </span>{' '}
                    /{' '}
                    <span className={terminalTextColor(theme)}>
                      {formatBytesInUnit(metrics.diskTotalBytes, metrics.diskUnitIndex)} {metrics.diskUnit}
                    </span>
                  </>
                ) : null}
              </>
            )}
          </span>
        )
      }
      return (
        <>
          <span className={clsx('mr-2', theme === 'dark' ? 'text-yellow-600' : 'text-amber-700')}>{event}</span>
          {Object.entries(rest).map(([key, value]) => (
            <span key={key} className="mr-2">
              <span className={theme === 'dark' ? 'text-gray-400' : 'text-slate-600'}>{key}=</span>
              <span>{insertBreaks(JSON.stringify(value))}</span>
            </span>
          ))}
        </>
      )
    } catch (error) {}
  }

  if (log.type === 'agent') {
    return (
      <>
        <span className={theme === 'dark' ? 'text-blue-300' : 'frameos-primary-text'}>{'[AGENT]'}</span>{' '}
        {insertBreaks(formattedLine)}
      </>
    )
  }

  return insertBreaks(formattedLine)
}

function formatTaskLogTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) {
    return ''
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function TaskToast({ task }: { task: LongRunningTask }): JSX.Element {
  const { frames } = useValues(framesModel)
  const { theme } = useValues(workspaceLogic)
  const { dismissTask, toggleTaskExpanded } = useActions(longRunningTasksModel)
  const frame = frames[task.frameId]
  const frameName = frame ? frame.name || frameHost(frame) : `Frame ${task.frameId}`
  const latestLog = task.logs[task.logs.length - 1]
  const logScrollRef = useRef<HTMLDivElement>(null)
  const currentDetail =
    task.status === 'running' && latestLog
      ? formatTaskLogLine(latestLog)
      : task.detail || (latestLog ? formatTaskLogLine(latestLog) : 'Waiting for frame signal')
  const hasProgress =
    typeof task.progressCurrent === 'number' && typeof task.progressTotal === 'number' && task.progressTotal > 0
  const progressPercent = hasProgress
    ? Math.max(0, Math.min(100, Math.round((task.progressCurrent! / task.progressTotal!) * 100)))
    : null

  useEffect(() => {
    if (!task.expanded || !logScrollRef.current) {
      return
    }
    requestAnimationFrame(() => {
      const element = logScrollRef.current
      if (element) {
        element.scrollTop = element.scrollHeight
      }
    })
  }, [task.expanded, task.logs.length])

  return (
    <div
      className={clsx(
        'w-full overflow-hidden rounded-lg border shadow-2xl shadow-slate-900/15 backdrop-blur-sm',
        taskTone(task, theme)
      )}
    >
      <div className="flex min-w-0 items-start gap-3 p-3">
        <div
          className={clsx(
            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            taskIconTone(task, theme)
          )}
        >
          {taskIcon(task.kind)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-sm font-semibold">{task.title}</div>
            <div className="shrink-0">{taskStatusIcon(task, theme)}</div>
          </div>
          <div className={clsx('mt-0.5 truncate text-xs', theme === 'dark' ? 'text-slate-400' : 'text-slate-500')}>
            {frameName}
          </div>
          <div
            className={clsx(
              'mt-1 truncate text-xs font-medium',
              theme === 'dark' ? 'text-slate-300' : 'text-slate-600'
            )}
          >
            {currentDetail}
          </div>
          {hasProgress ? (
            <div className="mt-2">
              <div
                className={clsx(
                  'h-1.5 overflow-hidden rounded-full',
                  theme === 'dark' ? 'bg-white/10' : 'bg-slate-200'
                )}
              >
                <div
                  className={clsx('h-full rounded-full', theme === 'dark' ? 'bg-blue-400' : 'bg-blue-500')}
                  style={{ width: `${progressPercent ?? 0}%` }}
                />
              </div>
              <div
                className={clsx(
                  'mt-1 truncate text-[11px] font-semibold',
                  theme === 'dark' ? 'text-slate-400' : 'text-slate-500'
                )}
              >
                {formatTaskBytes(task.progressCurrent ?? 0)} / {formatTaskBytes(task.progressTotal ?? 0)}
                {progressPercent !== null ? ` (${progressPercent}%)` : ''}
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <A
            href={urls.frame(task.frameId, 'logs')}
            title="All logs"
            aria-label="All logs"
            className={clsx(
              'flex h-8 w-8 items-center justify-center rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              theme === 'dark'
                ? 'text-slate-400 hover:bg-white/10 hover:text-blue-200'
                : 'text-slate-500 hover:bg-slate-100 hover:text-blue-700'
            )}
          >
            <DocumentTextIcon className="h-4 w-4" />
          </A>
          <button
            type="button"
            title={task.expanded ? 'Hide logs' : 'Show logs'}
            aria-label={task.expanded ? 'Hide logs' : 'Show logs'}
            onClick={() => toggleTaskExpanded(task.id)}
            className={clsx(
              'flex h-8 w-8 items-center justify-center rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              theme === 'dark'
                ? 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
            )}
          >
            {task.expanded ? <ChevronDownIcon className="h-4 w-4" /> : <ChevronUpIcon className="h-4 w-4" />}
          </button>
          <button
            type="button"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => dismissTask(task.id)}
            className={clsx(
              'flex h-8 w-8 items-center justify-center rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              theme === 'dark'
                ? 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
            )}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      {task.expanded ? (
        <div
          className={clsx(
            'border-t px-3 py-2',
            theme === 'dark'
              ? 'border-white/10 bg-slate-950/95 text-slate-100'
              : 'border-slate-200 bg-slate-50 text-slate-900'
          )}
        >
          <div ref={logScrollRef} className="max-h-72 overflow-y-auto font-mono text-xs leading-5">
            {task.logs.length === 0 ? (
              <div className="py-6 text-center text-slate-500">Waiting for logs...</div>
            ) : (
              task.logs.map((log) => {
                const formattedLine = formatTaskLogLine(log)
                const tone = taskLogTone(log, formattedLine, theme)

                return (
                  <div key={`${task.id}-${log.id}-${log.timestamp}`} className="flex gap-2">
                    <span className={clsx('mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} />
                    <span className={clsx('shrink-0', tone.timestamp)}>{formatTaskLogTimestamp(log.timestamp)}</span>
                    <span className={clsx('min-w-0 break-words', taskLogLineClassName(log, formattedLine, theme))}>
                      {renderTaskLogLine(log, formattedLine, theme)}
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function LongRunningTaskToasts(): JSX.Element | null {
  const { visibleTasks } = useValues(longRunningTasksModel)

  if (visibleTasks.length === 0) {
    return null
  }

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-[28rem] -translate-x-1/2 flex-col gap-3 sm:bottom-6">
      {visibleTasks.map((task) => (
        <div key={task.id} className="pointer-events-auto">
          <TaskToast task={task} />
        </div>
      ))}
    </div>
  )
}
