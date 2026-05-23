import { BindLogic, useActions, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import type { DragEvent } from 'react'
import {
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  CalendarDaysIcon,
  ChevronRightIcon,
  ComputerDesktopIcon,
  EyeIcon,
  PencilSquareIcon,
  PlusIcon,
  RocketLaunchIcon,
  SparklesIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'

import { DropdownMenu } from '../../components/DropdownMenu'
import { FrameImage } from '../../components/FrameImage'
import { frameHost, frameIsHealthy, frameIsStale, frameStatus } from '../../decorators/frame'
import { framesModel } from '../../models/framesModel'
import { urls } from '../../urls'
import type { FrameScene, FrameType, LogType, MetricsType, ScheduledEvent } from '../../types'
import { frameLogic } from '../frame/frameLogic'
import { logsLogic } from '../frame/panels/Logs/logsLogic'
import { metricsLogic } from '../frame/panels/Metrics/metricsLogic'
import { Schedule } from '../frame/panels/Schedule/Schedule'
import { controlLogic } from '../frame/panels/Scenes/controlLogic'
import { SceneDropDown } from '../frame/panels/Scenes/SceneDropDown'
import { newFrameForm } from '../frames/newFrameForm'
import { getFrameosSceneDragData, hasFrameosSceneDragData, setFrameosSceneDragData } from './sceneDrag'
import { workspaceLogic } from './workspaceLogic'

const uploadedScenePrefix = 'uploaded/'
const activeSurfaceClassName = 'border-[#4a4b8c] shadow-[0_0_3px_3px_rgba(128,0,255,0.5)]'
const statsTimeRangeMs = 4 * 60 * 60 * 1000

interface UsageSummary {
  total: number | null
  used: number | null
  available: number | null
  percentage: number | null
}

interface SystemMetricSnapshot {
  timestamp: string
  load: number[] | null
  memory: UsageSummary | null
  disk: UsageSummary | null
}

interface MetricSample {
  timestamp: number
  value: number
}

interface FrameDashboardSurfaceProps {
  frame: FrameType
  scenes: FrameScene[]
  totalScenes?: number
  archived?: boolean
  frameMatchesSearch?: boolean
  sectionId?: string
  showOpenFrameAction?: boolean
  showSceneMenus?: boolean
}

export function sceneIsActive(scene: FrameScene, currentSceneId: string | null | undefined): boolean {
  return currentSceneId === scene.id || currentSceneId === `${uploadedScenePrefix}${scene.id}`
}

function parseTimestamp(timestamp?: string | null): number {
  if (!timestamp) {
    return NaN
  }
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
  return Date.parse(hasTimeZone ? timestamp : `${timestamp}Z`)
}

function formatRelativeTime(timestamp?: string | null): string {
  if (!timestamp) {
    return 'Unknown'
  }
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) {
    return timestamp
  }
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 48) {
    return `${hours}h ago`
  }
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function isMetricRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeUsageSummary(value: unknown): UsageSummary | null {
  if (!isMetricRecord(value)) {
    return null
  }

  const total = finiteNumber(value.total)
  const available = finiteNumber(value.available ?? value.free)
  const rawUsed = finiteNumber(value.used)
  const used = rawUsed ?? (total !== null && available !== null ? Math.max(0, total - available) : null)
  const rawPercentage = finiteNumber(value.percentage)
  const percentage =
    rawPercentage ?? (total !== null && total > 0 && used !== null ? Math.max(0, (used / total) * 100) : null)

  if (total === null && used === null && available === null && percentage === null) {
    return null
  }

  return { total, used, available, percentage }
}

function normalizeLoad(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const load = value.map(finiteNumber).filter((entry): entry is number => entry !== null)
  return load.length > 0 ? load : null
}

function getLatestSystemMetricSnapshot(metrics: MetricsType[]): SystemMetricSnapshot | null {
  let latestMetric: MetricsType | null = null
  let latestTimestamp = -Infinity

  for (const metric of metrics) {
    const load = normalizeLoad(metric.metrics?.load)
    const memory = normalizeUsageSummary(metric.metrics?.memoryUsage)
    const disk = normalizeUsageSummary(metric.metrics?.diskUsage)
    if (!load && !memory && !disk) {
      continue
    }

    const timestamp = parseTimestamp(metric.timestamp)
    if (Number.isFinite(timestamp) && timestamp >= latestTimestamp) {
      latestTimestamp = timestamp
      latestMetric = metric
    }
  }

  if (!latestMetric) {
    return null
  }

  return {
    timestamp: latestMetric.timestamp,
    load: normalizeLoad(latestMetric.metrics?.load),
    memory: normalizeUsageSummary(latestMetric.metrics?.memoryUsage),
    disk: normalizeUsageSummary(latestMetric.metrics?.diskUsage),
  }
}

function getRenderTimestamp(logs: LogType[], fallback?: string | null): string | null {
  let latestTimestamp = fallback ?? null
  let latestTimestampMs = fallback ? parseTimestamp(fallback) : -Infinity

  logs.forEach((log) => {
    try {
      const { event } = JSON.parse(log.line)
      if (!['render:done', 'render:device', 'render'].includes(event)) {
        return
      }
      const timestamp = parseTimestamp(log.timestamp)
      if (Number.isFinite(timestamp) && timestamp >= latestTimestampMs) {
        latestTimestampMs = timestamp
        latestTimestamp = log.timestamp
      }
    } catch (error) {}
  })

  return latestTimestamp
}

function formatMetricNumber(value: number): string {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2)
}

function formatMetricPercent(value: number | null): string {
  return value === null ? 'Unknown' : `${Math.round(value)}%`
}

function formatMetricBytes(value: number | null): string | null {
  if (value === null) {
    return null
  }
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

function formatUsageDetail(usage: UsageSummary | null): string {
  if (!usage) {
    return 'No sample'
  }
  const used = formatMetricBytes(usage.used)
  const total = formatMetricBytes(usage.total)
  const available = formatMetricBytes(usage.available)

  if (used && total) {
    return `${used} / ${total}`
  }
  if (available && total) {
    return `${available} free of ${total}`
  }
  return used ?? available ?? 'No sample'
}

function usageTone(usage: UsageSummary | null): 'neutral' | 'good' | 'warning' | 'danger' {
  const percentage = usage?.percentage
  if (percentage === null || percentage === undefined) {
    return 'neutral'
  }
  if (percentage >= 90) {
    return 'danger'
  }
  if (percentage >= 75) {
    return 'warning'
  }
  return 'good'
}

function metricToneClasses(tone: 'neutral' | 'good' | 'warning' | 'danger'): { text: string; graph: string } {
  if (tone === 'good') {
    return { text: 'text-emerald-500', graph: 'text-emerald-500' }
  }
  if (tone === 'warning') {
    return { text: 'text-amber-500', graph: 'text-amber-500' }
  }
  if (tone === 'danger') {
    return { text: 'text-red-500', graph: 'text-red-500' }
  }
  return { text: 'frameos-primary-text', graph: 'frameos-primary-text' }
}

function metricSamples(metrics: MetricsType[], type: 'load' | 'memory' | 'disk'): MetricSample[] {
  const now = Date.now()
  const start = now - statsTimeRangeMs
  return metrics
    .map((metric): MetricSample | null => {
      const timestamp = parseTimestamp(metric.timestamp)
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > now + 60 * 1000) {
        return null
      }
      if (type === 'load') {
        const load = normalizeLoad(metric.metrics?.load)
        return load?.[0] !== undefined ? { timestamp, value: load[0] } : null
      }
      const usage = normalizeUsageSummary(type === 'memory' ? metric.metrics?.memoryUsage : metric.metrics?.diskUsage)
      return usage?.percentage !== null && usage?.percentage !== undefined
        ? { timestamp, value: usage.percentage }
        : null
    })
    .filter((sample): sample is MetricSample => sample !== null)
}

function MiniLineGraph({
  samples,
  tone = 'neutral',
}: {
  samples: MetricSample[]
  tone?: 'neutral' | 'good' | 'warning' | 'danger'
}): JSX.Element {
  const toneClasses = metricToneClasses(tone)

  if (samples.length < 2) {
    return <div className="frameos-muted flex h-10 items-center text-xs">No graph</div>
  }

  const minX = Math.min(...samples.map((sample) => sample.timestamp))
  const maxX = Math.max(...samples.map((sample) => sample.timestamp))
  const minY = Math.min(...samples.map((sample) => sample.value))
  const maxY = Math.max(...samples.map((sample) => sample.value))
  const yRange = Math.max(maxY - minY, 1)
  const xRange = Math.max(maxX - minX, 1)
  const points = samples
    .map((sample) => {
      const x = ((sample.timestamp - minX) / xRange) * 100
      const y = 36 - ((sample.value - minY) / yRange) * 30 - 3
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <svg viewBox="0 0 100 40" className={clsx('h-10 w-full overflow-visible', toneClasses.graph)}>
      <line x1="0" y1="36" x2="100" y2="36" className="stroke-current opacity-10" strokeWidth="1" />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3"
      />
    </svg>
  )
}

function FrameMetricStat({
  label,
  value,
  detail,
  samples,
  tone = 'neutral',
}: {
  label: string
  value: string
  detail: string
  samples?: MetricSample[]
  tone?: 'neutral' | 'good' | 'warning' | 'danger'
}): JSX.Element {
  const toneClasses = metricToneClasses(tone)

  return (
    <div className="frame-tool-card min-w-0 rounded-2xl p-3">
      <div className="frame-tool-muted text-[11px] font-semibold uppercase tracking-wide">{label}</div>
      <div className={clsx('mt-1 truncate text-xl font-bold tracking-normal', toneClasses.text)}>{value}</div>
      <div className="frame-tool-muted mt-0.5 truncate text-xs">{detail}</div>
      {samples ? (
        <div className="mt-2">
          <MiniLineGraph samples={samples} tone={tone} />
        </div>
      ) : null}
    </div>
  )
}

function scheduleWeekdayLabel(weekday?: number | null): string {
  if (!weekday) {
    return 'Every day'
  }
  if (weekday === 8) {
    return 'Weekdays'
  }
  if (weekday === 9) {
    return 'Weekends'
  }
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekday - 1] ?? 'Custom'
}

function scheduleTimeLabel(event: ScheduledEvent): string {
  return `${String(event.hour).padStart(2, '0')}:${String(event.minute).padStart(2, '0')}`
}

function FrameScheduleSummary({ frame, scenes }: { frame: FrameType; scenes: FrameScene[] }): JSX.Element {
  const { openScheduleDrawer } = useActions(workspaceLogic)
  const schedule = frame.schedule
  const events = schedule?.events ?? []
  const enabledEvents = events.filter((event) => !event.disabled)
  const disabled = !!schedule?.disabled
  const nextEvent = enabledEvents[0]
  const sceneNameById = new Map(scenes.map((scene) => [scene.id, scene.name || 'Untitled scene']))
  const summary = disabled
    ? 'Paused'
    : enabledEvents.length === 0
    ? 'No active entries'
    : `${enabledEvents.length} active ${enabledEvents.length === 1 ? 'entry' : 'entries'}`

  return (
    <div className="frame-tool-card rounded-2xl p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="frame-tool-muted text-[11px] font-semibold uppercase tracking-wide">Schedule</div>
          <div
            className={clsx(
              'mt-1 truncate text-xl font-bold tracking-normal',
              disabled || enabledEvents.length === 0 ? 'text-amber-500' : 'text-emerald-500'
            )}
          >
            {summary}
          </div>
          <div className="frame-tool-muted mt-0.5 truncate text-xs">
            {nextEvent
              ? `${scheduleTimeLabel(nextEvent)} · ${sceneNameById.get(nextEvent.payload.sceneId) ?? 'Unknown scene'}`
              : 'Edit automatic scene changes'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => openScheduleDrawer(frame.id)}
          className="frameos-primary-action inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <CalendarDaysIcon className="h-4 w-4" />
          Edit
        </button>
      </div>
      {nextEvent ? (
        <div className="frame-tool-muted mt-2 truncate text-xs">
          {scheduleWeekdayLabel(nextEvent.weekday)} · {events.length} total {events.length === 1 ? 'entry' : 'entries'}
        </div>
      ) : null}
    </div>
  )
}

function FramePreviewStats({ frame, scenes }: { frame: FrameType; scenes: FrameScene[] }): JSX.Element {
  const { logs } = useValues(logsLogic({ frameId: frame.id }))
  const { metrics, metricsLoading } = useValues(metricsLogic({ frameId: frame.id }))
  const latestRenderAt = getRenderTimestamp(logs, frame.last_log_at)
  const snapshot = getLatestSystemMetricSnapshot(metrics)
  const connected = (frame.active_connections ?? 0) > 0
  const load = snapshot?.load?.[0] ?? null
  const loadDetail = snapshot?.load
    ? snapshot.load.length >= 3
      ? `${formatMetricNumber(snapshot.load[1])} 5m / ${formatMetricNumber(snapshot.load[2])} 15m`
      : '1m load average'
    : metricsLoading
    ? 'Loading metrics...'
    : 'No sample'
  const memoryTone = usageTone(snapshot?.memory ?? null)
  const diskTone = usageTone(snapshot?.disk ?? null)
  const loadSamples = metricSamples(metrics, 'load')
  const memorySamples = metricSamples(metrics, 'memory')
  const diskSamples = metricSamples(metrics, 'disk')

  return (
    <div className="grid min-w-0 content-start gap-3 @md:grid-cols-2 @5xl:grid-cols-1">
      <FrameMetricStat
        label="Last render"
        value={formatRelativeTime(latestRenderAt)}
        detail={latestRenderAt ? 'Latest render log' : 'No render log yet'}
        tone={frameIsStale({ ...frame, last_log_at: latestRenderAt ?? frame.last_log_at }) ? 'warning' : 'neutral'}
      />
      <FrameMetricStat
        label="Agent"
        value={connected ? 'Online' : 'Offline'}
        detail={`${frame.active_connections ?? 0} active`}
        tone={connected ? 'good' : 'warning'}
      />
      <FrameMetricStat
        label="Load"
        value={load === null ? 'Unknown' : formatMetricNumber(load)}
        detail={loadDetail}
        samples={loadSamples}
        tone={load !== null && load >= 4 ? 'warning' : 'neutral'}
      />
      <FrameMetricStat
        label="Memory"
        value={formatMetricPercent(snapshot?.memory?.percentage ?? null)}
        detail={
          snapshot ? formatUsageDetail(snapshot?.memory ?? null) : metricsLoading ? 'Loading metrics...' : 'No sample'
        }
        samples={memorySamples}
        tone={memoryTone}
      />
      <FrameMetricStat
        label="Disk"
        value={formatMetricPercent(snapshot?.disk?.percentage ?? null)}
        detail={
          snapshot ? formatUsageDetail(snapshot?.disk ?? null) : metricsLoading ? 'Loading metrics...' : 'No sample'
        }
        samples={diskSamples}
        tone={diskTone}
      />
      <FrameScheduleSummary frame={frame} scenes={scenes} />
    </div>
  )
}

function frameAspectRatio(frame: FrameType): string | undefined {
  if (!frame.width || !frame.height) {
    return undefined
  }
  return frame.rotate === 90 || frame.rotate === 270
    ? `${frame.height} / ${frame.width}`
    : `${frame.width} / ${frame.height}`
}

function FramePreviewPanel({ frame, scenes }: { frame: FrameType; scenes: FrameScene[] }): JSX.Element {
  const aspectRatio = frameAspectRatio(frame)

  return (
    <div className="grid gap-4 @5xl:grid-cols-[minmax(18rem,28rem)_minmax(0,1fr)]">
      <A
        href={urls.frame(frame.id, 'preview')}
        className="frameos-card group min-w-0 overflow-hidden rounded-[24px] border border-white/90 bg-white text-left shadow-xl shadow-slate-300/35 transition hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-slate-300/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <div
          className={clsx(
            'frameos-card-media relative flex min-h-[22rem] items-center justify-center bg-slate-100',
            !aspectRatio && 'h-[32rem] max-h-[75vh]'
          )}
          style={aspectRatio ? { aspectRatio } : undefined}
        >
          <FrameImage
            frameId={frame.id}
            refreshable={false}
            objectFit="contain"
            className="h-full w-full rounded-none"
          />
          <div className="frameos-primary-hover-text absolute right-3 top-3 inline-flex items-center gap-1 rounded-lg bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-500 shadow-sm transition">
            <EyeIcon className="h-4 w-4" />
            Preview
          </div>
        </div>
      </A>
      <FramePreviewStats frame={frame} scenes={scenes} />
    </div>
  )
}

function FrameHeaderActions({
  frame,
  archived,
  showOpenFrameAction,
}: {
  frame: FrameType
  archived?: boolean
  showOpenFrameAction?: boolean
}): JSX.Element {
  const { deleteFrame, deployFrame, renderFrame, renameFrame, setFrameArchived } = useActions(framesModel)
  const { openChatDrawer, openScheduleDrawer } = useActions(workspaceLogic)
  const frameName = frame.name || frameHost(frame)

  const promptRenameFrame = (): void => {
    const nextName = window.prompt('Rename frame', frameName)?.trim()
    if (!nextName || nextName === frameName) {
      return
    }
    renameFrame(frame.id, nextName)
  }

  return (
    <div className="flex w-full shrink-0 flex-wrap items-center justify-start gap-2 @4xl:w-auto @4xl:justify-end">
      <button
        type="button"
        onClick={() => openScheduleDrawer(frame.id)}
        className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <CalendarDaysIcon className="h-5 w-5" />
        Schedule
      </button>
      {showOpenFrameAction ? (
        <A
          href={urls.frame(frame.id, 'overview')}
          className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg bg-white/80 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          Frame
          <ChevronRightIcon className="h-4 w-4" />
        </A>
      ) : null}
      <button
        type="button"
        title="Open AI chat"
        onClick={() => openChatDrawer(frame.id, null)}
        className="frameos-ai-button flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500 via-blue-500 to-cyan-400 text-white shadow-lg shadow-blue-500/25 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-blue-500/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <SparklesIcon className="h-5 w-5" />
      </button>
      <DropdownMenu
        buttonColor="none"
        horizontal
        className="frameos-secondary-button flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/80 !px-0 !py-0 text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        items={[
          {
            label: 'Rename',
            title: 'Rename frame',
            onClick: promptRenameFrame,
            icon: <PencilSquareIcon className="h-5 w-5" />,
          },
          {
            label: 'Render now',
            title: 'Render frame now',
            onClick: () => renderFrame(frame.id),
            icon: <PlayIcon className="h-5 w-5" />,
          },
          {
            label: 'Deploy',
            title: 'Deploy frame',
            onClick: () => deployFrame(frame.id),
            icon: <RocketLaunchIcon className="h-5 w-5" />,
          },
          {
            label: archived ? 'Restore' : 'Archive',
            title: archived ? 'Restore frame' : 'Archive frame',
            onClick: () => setFrameArchived(frame.id, !archived),
            icon: archived ? <ArrowUturnLeftIcon className="h-5 w-5" /> : <ArchiveBoxIcon className="h-5 w-5" />,
          },
          {
            label: 'Delete',
            title: 'Delete frame',
            confirm: `Delete "${frameName}"? This cannot be undone.`,
            onClick: () => deleteFrame(frame.id),
            icon: <TrashIcon className="h-5 w-5" />,
          },
        ]}
      />
    </div>
  )
}

function FrameDashboardHeader({
  frame,
  archived,
  showOpenFrameAction,
}: {
  frame: FrameType
  archived?: boolean
  showOpenFrameAction?: boolean
}): JSX.Element {
  const healthy = frameIsHealthy(frame)
  const connected = (frame.active_connections ?? 0) > 0

  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <A
        href={urls.frame(frame.id, 'overview')}
        className="group flex min-w-0 items-center gap-3 rounded-2xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <div className="frameos-icon-tile flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/70 text-slate-700 shadow-sm">
          <ComputerDesktopIcon className="h-7 w-7" />
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2
              data-workspace-frame-title={frame.id}
              className="frameos-strong truncate text-2xl font-bold tracking-normal text-slate-950"
            >
              {frame.name || frameHost(frame)}
            </h2>
            {archived ? (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500">
                Archived
              </span>
            ) : null}
            {healthy ? <span title="Frame is healthy" className="h-2.5 w-2.5 rounded-full bg-emerald-400" /> : null}
            {connected ? (
              <span title="FrameOS agent connected" className="h-2.5 w-2.5 rounded-full bg-blue-400" />
            ) : null}
          </div>
          <div className="frameos-muted truncate text-sm text-slate-500">{frameStatus(frame)}</div>
        </div>
      </A>
      <FrameHeaderActions frame={frame} archived={archived} showOpenFrameAction={showOpenFrameAction} />
    </div>
  )
}

function FrameSceneTile({
  frame,
  scene,
  active,
  showMenu,
}: {
  frame: FrameType
  scene: FrameScene
  active: boolean
  showMenu?: boolean
}): JSX.Element {
  const { openSceneControl } = useActions(workspaceLogic)
  const { hideForm } = useActions(newFrameForm)
  const fieldCount = scene.fields?.filter((field) => field.access === 'public').length ?? 0

  return (
    <div
      draggable
      onDragStart={(event) => setFrameosSceneDragData(event.dataTransfer, scene.id)}
      className={clsx(
        'frameos-card group relative h-36 w-36 shrink-0 overflow-hidden rounded-2xl border bg-white text-left transition hover:-translate-y-0.5 focus-within:ring-2 focus-within:ring-blue-400',
        active
          ? `${activeSurfaceClassName} hover:shadow-[0_0_4px_4px_rgba(128,0,255,0.55)]`
          : 'border-white/90 shadow-lg shadow-slate-300/35 hover:shadow-xl hover:shadow-slate-300/50'
      )}
    >
      <button
        type="button"
        onClick={() => {
          hideForm()
          openSceneControl(frame.id, scene.id)
        }}
        className="flex h-full w-full flex-col"
      >
        <div className="frameos-card-media relative flex min-h-0 flex-1 items-center justify-center bg-slate-100">
          <FrameImage
            frameId={frame.id}
            sceneId={scene.id}
            thumb
            refreshable={false}
            objectFit="cover"
            className="h-full w-full rounded-none"
          />
          {active ? (
            <div className="absolute left-2 top-2 rounded-full bg-[#4a4b8c] px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm">
              Active
            </div>
          ) : null}
          <div className="frameos-primary-hover-text absolute right-2 top-2 rounded-full bg-white/90 p-1 text-slate-400 shadow-sm transition">
            <EyeIcon className="h-4 w-4" />
          </div>
        </div>
        <div className="w-full px-3 py-2">
          <div className="frameos-strong truncate text-sm font-semibold text-slate-900">
            {scene.name || 'Untitled scene'}
          </div>
          <div className="frameos-muted mt-0.5 truncate text-xs text-slate-500">
            {scene.nodes?.length ?? 0} nodes
            {fieldCount > 0 ? ` · ${fieldCount} controls` : ''}
          </div>
        </div>
      </button>
      {showMenu ? (
        <SceneDropDown
          context="scenes"
          sceneId={scene.id}
          horizontal
          buttonColor="none"
          className="absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-white/90 !px-0 !py-0 text-slate-600 shadow-sm"
        />
      ) : null}
    </div>
  )
}

export function FrameAddSceneTile({ frame, compact = false }: { frame: FrameType; compact?: boolean }): JSX.Element {
  const { hideForm } = useActions(newFrameForm)
  const { closeSceneControl, openTemplateDrawer } = useActions(workspaceLogic)

  return (
    <button
      type="button"
      onClick={() => {
        hideForm()
        closeSceneControl()
        openTemplateDrawer(frame.id)
      }}
      className={clsx(
        'frameos-primary-hover-text frameos-card group flex shrink-0 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white/55 text-center text-slate-500 shadow-sm transition hover:-translate-y-0.5 hover:bg-white/80 hover:shadow-lg hover:shadow-slate-300/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        compact ? 'h-36 w-36' : 'min-h-36 w-full max-w-40 min-w-0'
      )}
    >
      <span className="frameos-primary-hover-text frameos-icon-tile flex h-12 w-12 items-center justify-center rounded-full bg-white/80 text-slate-400 shadow-sm transition">
        <PlusIcon className="h-7 w-7" />
      </span>
      <span className="frameos-strong text-sm font-semibold text-slate-700">Add scene</span>
    </button>
  )
}

function FrameScenesBlock({
  frame,
  scenes,
  totalScenes,
  frameMatchesSearch,
  showSceneMenus,
}: {
  frame: FrameType
  scenes: FrameScene[]
  totalScenes: number
  frameMatchesSearch?: boolean
  showSceneMenus?: boolean
}): JSX.Element {
  const { search } = useValues(workspaceLogic)
  const { openSceneControl } = useActions(workspaceLogic)
  const { sceneId: currentSceneId } = useValues(controlLogic({ frameId: frame.id }))

  const handleScenesDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFrameosSceneDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const handleScenesDrop = (event: DragEvent<HTMLDivElement>) => {
    const sceneId = getFrameosSceneDragData(event.dataTransfer)
    if (!sceneId || !frame.scenes?.some((scene) => scene.id === sceneId)) {
      return
    }
    event.preventDefault()
    openSceneControl(frame.id, sceneId)
  }

  return (
    <div onDragOver={handleScenesDragOver} onDrop={handleScenesDrop}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-500">Scenes</div>
          <h3 className="frameos-strong text-2xl font-bold tracking-normal text-slate-950">
            {totalScenes} {totalScenes === 1 ? 'scene' : 'scenes'}
          </h3>
        </div>
      </div>
      {scenes.length > 0 ? (
        <div className="flex flex-wrap gap-4">
          {scenes.map((scene) => (
            <FrameSceneTile
              key={scene.id}
              frame={frame}
              scene={scene}
              active={sceneIsActive(scene, currentSceneId)}
              showMenu={showSceneMenus}
            />
          ))}
          <FrameAddSceneTile frame={frame} compact />
        </div>
      ) : search.trim() && frameMatchesSearch ? (
        <div className="frameos-empty flex h-40 min-w-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/45 px-6 text-center text-sm font-medium text-slate-500">
          Frame matched. No scenes match this search.
        </div>
      ) : search.trim() && totalScenes > 0 ? (
        <div className="frameos-empty flex h-40 min-w-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/45 px-6 text-center text-sm font-medium text-slate-500">
          No scenes match this search.
        </div>
      ) : (
        <div className="flex flex-wrap gap-4">
          <FrameAddSceneTile frame={frame} compact />
        </div>
      )}
    </div>
  )
}

export function FrameDashboardSurface({
  frame,
  scenes,
  totalScenes = scenes.length,
  archived,
  frameMatchesSearch,
  sectionId,
  showOpenFrameAction = false,
  showSceneMenus = false,
}: FrameDashboardSurfaceProps): JSX.Element {
  return (
    <section
      id={sectionId}
      data-workspace-frame-section={frame.id}
      className={clsx('group @container scroll-mt-6', archived && 'opacity-80')}
    >
      <FrameDashboardHeader frame={frame} archived={archived} showOpenFrameAction={showOpenFrameAction} />
      <div className="space-y-6">
        <FramePreviewPanel frame={frame} scenes={frame.scenes ?? scenes} />
        <FrameScenesBlock
          frame={frame}
          scenes={scenes}
          totalScenes={totalScenes}
          frameMatchesSearch={frameMatchesSearch}
          showSceneMenus={showSceneMenus}
        />
      </div>
    </section>
  )
}

export function FrameScheduleDrawer({ frame }: { frame: FrameType }): JSX.Element {
  const { closeScheduleDrawer } = useActions(workspaceLogic)
  const frameLogicProps = { frameId: frame.id }

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 w-[430px] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <div className="flex h-full flex-col">
        <div className="frameos-divider flex items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
          <div className="min-w-0">
            <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
              {frame.name || frameHost(frame)}
            </div>
            <h2 className="frameos-strong truncate text-xl font-bold tracking-normal text-slate-950">Schedule</h2>
          </div>
          <button
            type="button"
            onClick={closeScheduleDrawer}
            className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <BindLogic logic={frameLogic} props={frameLogicProps}>
            <Schedule scrollContainer={false} drawerMode />
          </BindLogic>
        </div>
      </div>
    </div>
  )
}
