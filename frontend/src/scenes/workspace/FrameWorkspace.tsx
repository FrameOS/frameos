import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import { useCallback, useLayoutEffect, useRef, type DragEvent } from 'react'
import {
  AdjustmentsHorizontalIcon,
  BoltIcon,
  ChartBarIcon,
  CircleStackIcon,
  CommandLineIcon,
  DocumentTextIcon,
  EyeIcon,
  SignalIcon,
  Squares2X2Icon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { frameHost, frameIsHealthy, frameIsStale, logUpdatesFrameActivity } from '../../decorators/frame'
import { FrameImage } from '../../components/FrameImage'
import { FrameScene, FrameType, LogType, MetricsType, ScheduledEvent } from '../../types'
import { framesModel } from '../../models/framesModel'
import { FrameosShell } from './FrameosShell'
import { AddSceneTile, SceneControlPanel, TemplateDrawer } from './FramesHome'
import { FrameDashboardSurface, FrameScheduleDrawer } from './FrameDashboardSurface'
import { FrameSidebarPreview } from './FrameSidebarPreview'
import { sceneWorkspaceLogic } from './sceneWorkspaceLogic'
import { frameToolScrollKey, workspaceLogic, WorkspaceUtilityPanel } from './workspaceLogic'
import { urls } from '../../urls'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { terminalLogic } from '../frame/panels/Terminal/terminalLogic'
import { frameSettingsLogic } from '../frame/panels/FrameSettings/frameSettingsLogic'
import { logsLogic } from '../frame/panels/Logs/logsLogic'
import { metricsLogic } from '../frame/panels/Metrics/metricsLogic'
import { controlLogic } from '../frame/panels/Scenes/controlLogic'
import { SceneDropDown } from '../frame/panels/Scenes/SceneDropDown'
import { Assets } from '../frame/panels/Assets/Assets'
import { Debug } from '../frame/panels/Debug/Debug'
import { FrameSettings } from '../frame/panels/FrameSettings/FrameSettings'
import { Image } from '../frame/panels/Image/Image'
import { Logs } from '../frame/panels/Logs/Logs'
import { Metrics } from '../frame/panels/Metrics/Metrics'
import { Ping } from '../frame/panels/Ping/Ping'
import { Schedule } from '../frame/panels/Schedule/Schedule'
import { Terminal } from '../frame/panels/Terminal/Terminal'
import { getFrameosSceneDragData, hasFrameosSceneDragData, setFrameosSceneDragData } from './sceneDrag'
import { groupFramesByStatus } from './frameStatusGroups'

interface FrameWorkspaceProps {
  id?: string
}

interface FrameToolDefinition {
  panel: WorkspaceUtilityPanel
  label: string
  description: string
  icon: JSX.Element
}

const uploadedScenePrefix = 'uploaded/'
const activeSurfaceClassName = 'frameos-active-surface'
const scrollRestoreMaxDurationMs = 1500
const scrollRestoreRetryMs = 50
const scrollRestoreTolerance = 2

function frameWorkspaceMainElement(): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null
  }
  return document.querySelector<HTMLElement>('[data-workspace-main="frame"]')
}

function frameWorkspaceMainScrollElement(): HTMLElement | null {
  if (typeof window === 'undefined') {
    return null
  }

  const main = frameWorkspaceMainElement()
  if (!main) {
    return null
  }

  const mainStyle = window.getComputedStyle(main)
  const mainCanScroll = main.scrollHeight > main.clientHeight + 1 && mainStyle.overflowY !== 'visible'
  return mainCanScroll ? main : null
}

function frameToolScrollTarget(): HTMLElement | Window | null {
  if (typeof window === 'undefined') {
    return null
  }
  return frameWorkspaceMainScrollElement() ?? window
}

function readFrameToolScrollTop(): number {
  const main = frameWorkspaceMainScrollElement()
  if (main) {
    return main.scrollTop
  }
  if (typeof window === 'undefined') {
    return 0
  }
  return document.scrollingElement?.scrollTop ?? window.scrollY
}

function frameToolMaxScrollTop(): number {
  const main = frameWorkspaceMainScrollElement()
  if (main) {
    return Math.max(0, main.scrollHeight - main.clientHeight)
  }
  if (typeof window === 'undefined') {
    return 0
  }
  const scrollElement = document.scrollingElement ?? document.documentElement
  return Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight)
}

function scrollFrameToolTo(scrollTop: number): void {
  const nextScrollTop = Math.max(0, scrollTop)
  const main = frameWorkspaceMainScrollElement()
  if (main) {
    main.scrollTo({ top: nextScrollTop, behavior: 'auto' })
  } else if (typeof window !== 'undefined') {
    window.scrollTo({ top: nextScrollTop, behavior: 'auto' })
  }
}

function restoreFrameToolScrollTop(scrollTop: number): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  const targetScrollTop = Math.max(0, Math.round(scrollTop))
  if (targetScrollTop === 0) {
    scrollFrameToolTo(0)
    return () => {}
  }

  let cancelled = false
  let animationFrameId: number | null = null
  let timeoutId: number | null = null
  const startedAt = window.performance.now()

  const cancel = () => {
    cancelled = true
    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
      timeoutId = null
    }
    window.removeEventListener('wheel', cancel)
    window.removeEventListener('touchstart', cancel)
    window.removeEventListener('keydown', cancel)
  }

  const scheduleRestore = (delayMs = 0) => {
    if (cancelled) {
      return
    }
    if (delayMs > 0) {
      timeoutId = window.setTimeout(restore, delayMs)
    } else {
      animationFrameId = window.requestAnimationFrame(restore)
    }
  }

  const restore = () => {
    if (cancelled) {
      return
    }
    animationFrameId = null
    timeoutId = null
    scrollFrameToolTo(targetScrollTop)

    const currentScrollTop = readFrameToolScrollTop()
    const reachedTarget = Math.abs(currentScrollTop - targetScrollTop) <= scrollRestoreTolerance
    const expired = window.performance.now() - startedAt >= scrollRestoreMaxDurationMs
    if (reachedTarget || expired) {
      cancel()
      return
    }

    const contentCanReachTarget = frameToolMaxScrollTop() + scrollRestoreTolerance >= targetScrollTop
    scheduleRestore(contentCanReachTarget ? 0 : scrollRestoreRetryMs)
  }

  window.addEventListener('wheel', cancel, { passive: true })
  window.addEventListener('touchstart', cancel, { passive: true })
  window.addEventListener('keydown', cancel)

  restore()
  return cancel
}

function frameToolInitialScrollTop(
  positions: Record<string, number>,
  frameId: number,
  panel: WorkspaceUtilityPanel
): number | null {
  const key = frameToolScrollKey(frameId, panel)
  if (Object.prototype.hasOwnProperty.call(positions, key)) {
    return positions[key]
  }

  return panel === 'logs' || panel === 'terminal' ? null : 0
}

const frameToolDefinitions: FrameToolDefinition[] = [
  {
    panel: 'overview',
    label: 'Overview',
    description: 'Preview and scenes',
    icon: <Squares2X2Icon className="h-5 w-5" />,
  },
  { panel: 'preview', label: 'Preview', description: 'Current image', icon: <EyeIcon className="h-5 w-5" /> },
  { panel: 'logs', label: 'Logs', description: 'Runtime output', icon: <DocumentTextIcon className="h-5 w-5" /> },
  { panel: 'metrics', label: 'Metrics', description: 'Health charts', icon: <ChartBarIcon className="h-5 w-5" /> },
  { panel: 'assets', label: 'Assets', description: 'Files on frame', icon: <CircleStackIcon className="h-5 w-5" /> },
  { panel: 'terminal', label: 'Terminal', description: 'Shell access', icon: <CommandLineIcon className="h-5 w-5" /> },
  { panel: 'ping', label: 'Ping', description: 'Connectivity', icon: <SignalIcon className="h-5 w-5" /> },
  { panel: 'debug', label: 'Debug', description: 'Diagnostics', icon: <BoltIcon className="h-5 w-5" /> },
  {
    panel: 'settings',
    label: 'Settings',
    description: 'Frame config',
    icon: <AdjustmentsHorizontalIcon className="h-5 w-5" />,
  },
]

const frameSettingsSections = [
  { id: 'frame-settings-info', label: 'Info' },
  { id: 'frame-settings-device', label: 'Device' },
  { id: 'frame-settings-ssh', label: 'SSH' },
  { id: 'frame-settings-agent', label: 'Agent' },
  { id: 'frame-settings-backend', label: 'Backend' },
  { id: 'frame-http-api-section', label: 'HTTP API' },
  { id: 'frame-settings-admin', label: 'Admin' },
  { id: 'frame-http-proxy-section', label: 'HTTPS' },
  { id: 'frame-settings-network', label: 'Network' },
  { id: 'frame-settings-defaults', label: 'Defaults' },
  { id: 'frame-settings-palette', label: 'Palette' },
  { id: 'frame-settings-qr', label: 'QR code' },
  { id: 'frame-settings-assets', label: 'Assets' },
  { id: 'frame-settings-gpio', label: 'GPIO' },
  { id: 'frame-settings-logs', label: 'Logs' },
  { id: 'frame-settings-reboot', label: 'Reboot' },
]

function scrollToFrameSettingsSection(sectionId: string, attempt = 0): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return
  }

  window.requestAnimationFrame(() => {
    const section = document.getElementById(sectionId)
    if (section) {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }

    if (attempt < 8) {
      window.setTimeout(() => scrollToFrameSettingsSection(sectionId, attempt + 1), 50)
    }
  })
}

function parseFrameId(frameId?: string): number | null {
  if (!frameId) {
    return null
  }
  const parsed = parseInt(frameId, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function FrameSelector({ frame, frames }: { frame: FrameType; frames: FrameType[] }): JSX.Element {
  const { navigateToFrame } = useActions(workspaceLogic)
  const frameGroups = groupFramesByStatus(frames)

  return (
    <div className="px-2">
      <label className="frameos-muted mb-2 block text-xs font-semibold uppercase tracking-wide">Frame</label>
      <select
        value={frame.id}
        onChange={(event) => navigateToFrame(parseInt(event.target.value, 10))}
        className="frameos-form-control w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-400"
      >
        {frameGroups.map((group) => (
          <optgroup key={group.key} label={group.label}>
            {group.frames.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name || frameHost(candidate)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
}

function FrameSettingsSectionLinks({ frameId }: { frameId: number }): JSX.Element {
  const { openFrameTool } = useActions(workspaceLogic)
  const splitIndex = Math.ceil(frameSettingsSections.length / 2)
  const sectionColumns = [frameSettingsSections.slice(0, splitIndex), frameSettingsSections.slice(splitIndex)]

  return (
    <div className="frameos-frame-tool-subnav ml-12 grid grid-cols-2 gap-x-1 border-l border-slate-200/70 pl-3">
      {sectionColumns.map((sections, columnIndex) => (
        <div key={columnIndex} className="grid gap-1">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => {
                openFrameTool(frameId, 'settings')
                scrollToFrameSettingsSection(section.id)
              }}
              className="frameos-frame-tool-subrow min-w-0 rounded-lg px-2 py-1 text-left text-xs font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <span className="block truncate">{section.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function FrameToolRow({
  definition,
  active,
  frameId,
}: {
  definition: FrameToolDefinition
  active: boolean
  frameId: number
}): JSX.Element {
  return (
    <A
      href={urls.frame(frameId, definition.panel)}
      className={clsx(
        'frameos-frame-tool-row flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active ? 'frameos-frame-tool-row-selected' : 'text-slate-700 hover:bg-slate-100'
      )}
    >
      <span
        className={clsx(
          'frameos-frame-tool-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
          active ? 'frameos-frame-tool-icon-selected' : 'bg-slate-100 text-slate-500'
        )}
      >
        {definition.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{definition.label}</span>
        <span className={clsx('frameos-frame-tool-description block truncate text-xs', !active && 'text-slate-400')}>
          {definition.description}
        </span>
      </span>
    </A>
  )
}

function FrameTree({
  frame,
  frames,
  activeTool,
}: {
  frame: FrameType
  frames: FrameType[]
  activeTool: WorkspaceUtilityPanel
}): JSX.Element {
  return (
    <div className="space-y-5">
      <FrameSelector frame={frame} frames={frames} />
      <FrameSidebarPreview frame={frame} active={activeTool === 'preview'} className="mx-2" />
      <div>
        <div className="frameos-muted mb-2 px-2 text-xs font-semibold uppercase tracking-wide">Frame Tools</div>
        <div className="space-y-1">
          {frameToolDefinitions.map((definition) => {
            const active = activeTool === definition.panel
            return (
              <div key={definition.panel} className="space-y-1">
                <FrameToolRow definition={definition} active={active} frameId={frame.id} />
                {definition.panel === 'settings' && active ? <FrameSettingsSectionLinks frameId={frame.id} /> : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function sceneIsActive(scene: FrameScene, currentSceneId: string | null | undefined): boolean {
  return currentSceneId === scene.id || currentSceneId === `${uploadedScenePrefix}${scene.id}`
}

function SceneTile({ frame, scene, active }: { frame: FrameType; scene: FrameScene; active: boolean }): JSX.Element {
  const { openSceneControl } = useActions(workspaceLogic)
  const fieldCount = scene.fields?.filter((field) => field.access === 'public').length ?? 0

  return (
    <div
      draggable
      data-workspace-scene-tile={scene.id}
      data-workspace-scene-tile-frame={frame.id}
      onDragStart={(event) => setFrameosSceneDragData(event.dataTransfer, scene.id)}
      className={clsx(
        'frameos-card group relative h-36 w-36 shrink-0 overflow-hidden rounded-2xl border bg-white text-left transition hover:-translate-y-0.5 focus-within:ring-2 focus-within:ring-blue-400',
        active
          ? activeSurfaceClassName
          : 'border-white/90 shadow-lg shadow-slate-300/35 hover:shadow-xl hover:shadow-slate-300/50'
      )}
    >
      <button
        type="button"
        onClick={() => openSceneControl(frame.id, scene.id)}
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
            <div className="frameos-primary-fill absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm">
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
      <SceneDropDown
        context="scenes"
        sceneId={scene.id}
        horizontal
        buttonColor="none"
        className="absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-white/90 !px-0 !py-0 text-slate-600 shadow-sm"
      />
    </div>
  )
}

function FrameScenesSurface({
  frame,
  scenes,
  totalScenes,
}: {
  frame: FrameType
  scenes: FrameScene[]
  totalScenes: number
}): JSX.Element {
  const { search } = useValues(workspaceLogic)
  const { openScheduleDrawer, openSceneControl } = useActions(workspaceLogic)
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

  const header = (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="frameos-muted text-xs font-semibold text-slate-500">
          {totalScenes} {totalScenes === 1 ? 'scene' : 'scenes'}
        </div>
      </div>
      <button
        type="button"
        onClick={() => openScheduleDrawer(frame.id)}
        className="frameos-secondary-button rounded-lg bg-white/80 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        Schedule
      </button>
    </div>
  )

  if (scenes.length === 0) {
    if (totalScenes > 0 && search.trim()) {
      return (
        <div onDragOver={handleScenesDragOver} onDrop={handleScenesDrop}>
          {header}
          <div className="frameos-empty flex h-40 min-w-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/45 px-6 text-center text-sm font-medium text-slate-500">
            No scenes match this search.
          </div>
        </div>
      )
    }

    return (
      <div onDragOver={handleScenesDragOver} onDrop={handleScenesDrop}>
        {header}
        <div className="flex flex-wrap gap-4">
          <AddSceneTile frame={frame} compact />
        </div>
      </div>
    )
  }

  return (
    <div onDragOver={handleScenesDragOver} onDrop={handleScenesDrop}>
      {header}
      <div className="flex flex-wrap gap-4">
        {scenes.map((scene) => (
          <SceneTile key={scene.id} frame={frame} scene={scene} active={sceneIsActive(scene, currentSceneId)} />
        ))}
        <AddSceneTile frame={frame} compact />
      </div>
    </div>
  )
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

function frameStatusText(frame: FrameType): string {
  if (frameIsStale(frame)) {
    return 'stale'
  }
  if (frame.status === 'ready' && (frame.active_connections ?? 0) > 0) {
    return 'connected'
  }
  return frame.status
}

function OverviewStatCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: string
  detail?: string
  tone?: 'neutral' | 'good' | 'warning' | 'danger'
}): JSX.Element {
  const toneClassName =
    tone === 'good'
      ? 'text-emerald-500'
      : tone === 'warning'
      ? 'text-amber-500'
      : tone === 'danger'
      ? 'text-red-500'
      : 'frameos-primary-text'

  return (
    <div className="frame-tool-card rounded-[22px] p-4">
      <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{label}</div>
      <div className={clsx('mt-2 truncate text-2xl font-bold tracking-normal', toneClassName)}>{value}</div>
      {detail ? <div className="frame-tool-muted mt-1 truncate text-sm">{detail}</div> : null}
    </div>
  )
}

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

function parseMetricTimestamp(timestamp: string): number {
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
  return Date.parse(hasTimeZone ? timestamp : `${timestamp}Z`)
}

function isMetricRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
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

    const timestamp = parseMetricTimestamp(metric.timestamp)
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

function getLatestLogTimestamp(logs: LogType[], fallback?: string | null): string | null {
  let latestTimestamp = fallback ?? null
  let latestTimestampMs = fallback ? parseMetricTimestamp(fallback) : -Infinity

  logs.forEach((log) => {
    if (!logUpdatesFrameActivity(log)) {
      return
    }
    const timestamp = parseMetricTimestamp(log.timestamp)
    if (Number.isFinite(timestamp) && timestamp >= latestTimestampMs) {
      latestTimestampMs = timestamp
      latestTimestamp = log.timestamp
    }
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

function metricToneClasses(tone: 'neutral' | 'good' | 'warning' | 'danger'): { text: string; bar: string } {
  if (tone === 'good') {
    return { text: 'text-emerald-500', bar: 'bg-emerald-500' }
  }
  if (tone === 'warning') {
    return { text: 'text-amber-500', bar: 'bg-amber-500' }
  }
  if (tone === 'danger') {
    return { text: 'text-red-500', bar: 'bg-red-500' }
  }
  return { text: 'frameos-primary-text', bar: 'frameos-primary-fill' }
}

function OverviewMetricTile({
  label,
  value,
  detail,
  percentage,
  tone = 'neutral',
}: {
  label: string
  value: string
  detail: string
  percentage?: number | null
  tone?: 'neutral' | 'good' | 'warning' | 'danger'
}): JSX.Element {
  const toneClasses = metricToneClasses(tone)
  const clampedPercentage =
    percentage === null || percentage === undefined ? null : Math.max(0, Math.min(100, percentage))

  return (
    <div className="frame-tool-card rounded-[22px] p-4">
      <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{label}</div>
      <div className={clsx('mt-1 truncate text-xl font-bold tracking-normal', toneClasses.text)}>{value}</div>
      <div className="frame-tool-muted mt-0.5 truncate text-xs">{detail}</div>
      {clampedPercentage !== null ? (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200/80">
          <div className={clsx('h-full rounded-full', toneClasses.bar)} style={{ width: `${clampedPercentage}%` }} />
        </div>
      ) : null}
    </div>
  )
}

function OverviewSystemMetricTiles({
  frame,
  metrics,
  metricsLoading,
}: {
  frame: FrameType
  metrics: MetricsType[]
  metricsLoading: boolean
}): JSX.Element {
  const snapshot = getLatestSystemMetricSnapshot(metrics)
  const load = snapshot?.load?.[0] ?? null
  const loadDetail = snapshot?.load
    ? snapshot.load.length >= 3
      ? `${formatMetricNumber(snapshot.load[1])} 5m / ${formatMetricNumber(snapshot.load[2])} 15m`
      : '1m load average'
    : 'No sample'
  const memoryTone = usageTone(snapshot?.memory ?? null)
  const diskTone = usageTone(snapshot?.disk ?? null)
  const emptyDetail = metricsLoading
    ? 'Loading metrics...'
    : frame.metrics_interval > 0
    ? 'Waiting for sample'
    : 'Metrics disabled'

  return (
    <>
      <OverviewMetricTile
        label="Load"
        value={load === null ? 'Unknown' : formatMetricNumber(load)}
        detail={snapshot ? loadDetail : emptyDetail}
        tone={load !== null && load >= 4 ? 'warning' : 'neutral'}
      />
      <OverviewMetricTile
        label="Memory"
        value={formatMetricPercent(snapshot?.memory?.percentage ?? null)}
        detail={snapshot ? formatUsageDetail(snapshot?.memory ?? null) : emptyDetail}
        percentage={snapshot?.memory?.percentage}
        tone={memoryTone}
      />
      <OverviewMetricTile
        label="Disk"
        value={formatMetricPercent(snapshot?.disk?.percentage ?? null)}
        detail={snapshot ? formatUsageDetail(snapshot?.disk ?? null) : emptyDetail}
        percentage={snapshot?.disk?.percentage}
        tone={diskTone}
      />
    </>
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

function OverviewScheduleCard({ frame, scenes }: { frame: FrameType; scenes: FrameScene[] }): JSX.Element {
  const { openScheduleDrawer } = useActions(workspaceLogic)
  const schedule = frame.schedule
  const events = schedule?.events ?? []
  const enabledEvents = events.filter((event) => !event.disabled)
  const disabled = !!schedule?.disabled
  const visibleEvents = enabledEvents.slice(0, 3)
  const sceneNameById = new Map(scenes.map((scene) => [scene.id, scene.name || 'Untitled scene']))
  const summary = disabled
    ? 'Paused'
    : enabledEvents.length === 0
    ? 'No active entries'
    : `${enabledEvents.length} active ${enabledEvents.length === 1 ? 'entry' : 'entries'}`

  return (
    <div className="frame-tool-card rounded-[22px] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Schedule</div>
          <div
            className={clsx(
              'mt-1 truncate text-xl font-bold tracking-normal',
              disabled || enabledEvents.length === 0 ? 'text-amber-500' : 'text-emerald-500'
            )}
          >
            {summary}
          </div>
          <div className="frame-tool-muted mt-0.5 truncate text-xs">
            {events.length} total {events.length === 1 ? 'entry' : 'entries'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => openScheduleDrawer(frame.id)}
          className="frameos-secondary-button rounded-lg px-3 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          Open
        </button>
      </div>
      {visibleEvents.length > 0 ? (
        <div className="mt-4 space-y-2">
          {visibleEvents.map((event) => (
            <div key={event.id} className="flex items-center gap-3 rounded-xl bg-slate-500/10 px-3 py-2 text-sm">
              <div className="shrink-0 font-bold text-[color:var(--tool-strong)]">{scheduleTimeLabel(event)}</div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-[color:var(--tool-strong)]">
                  {sceneNameById.get(event.payload.sceneId) ?? 'Unknown scene'}
                </div>
                <div className="frame-tool-muted truncate text-xs">{scheduleWeekdayLabel(event.weekday)}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="frame-tool-muted mt-4 rounded-xl bg-slate-500/10 px-3 py-3 text-sm">
          Add entries to rotate scenes automatically.
        </div>
      )}
    </div>
  )
}

function FrameOverviewSurface({ frame, scenes }: { frame: FrameType; scenes: FrameScene[] }): JSX.Element {
  const { logs } = useValues(logsLogic({ frameId: frame.id }))
  const { metrics, metricsLoading } = useValues(metricsLogic({ frameId: frame.id }))
  const latestLogAt = getLatestLogTimestamp(logs, frame.last_log_at)
  const frameWithLatestLog = latestLogAt ? { ...frame, last_log_at: latestLogAt } : frame
  const stale = frameIsStale(frameWithLatestLog)
  const healthy = frameIsHealthy(frameWithLatestLog)
  const connected = (frame.active_connections ?? 0) > 0
  const healthTone = healthy ? 'good' : stale ? 'warning' : frame.status === 'error' ? 'danger' : 'neutral'
  const frameAspectRatio =
    frame.width && frame.height
      ? frame.rotate === 90 || frame.rotate === 270
        ? `${frame.height} / ${frame.width}`
        : `${frame.width} / ${frame.height}`
      : null

  return (
    <div className="frame-tool-panel @container grid min-h-0 content-start gap-x-5 gap-y-3 @4xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)]">
      <header className="min-w-0 @4xl:col-span-2">
        <h1 className="frameos-strong truncate text-3xl font-bold leading-tight tracking-normal text-slate-950 @md:text-4xl">
          {frame.name || frameHost(frame)}
        </h1>
      </header>
      <div className="space-y-5">
        <div className="grid gap-4 @md:grid-cols-2 @6xl:grid-cols-4">
          <OverviewStatCard
            label="Health"
            value={healthy ? 'Healthy' : stale ? 'Stale' : frame.status}
            tone={healthTone}
          />
          <OverviewStatCard
            label="Agent"
            value={connected ? 'Online' : 'Offline'}
            detail={`${frame.active_connections ?? 0} active`}
            tone={connected ? 'good' : 'warning'}
          />
          <OverviewStatCard
            label="Scenes"
            value={String(scenes.length)}
            detail={scenes.length === 1 ? '1 scene deployed' : `${scenes.length} scenes deployed`}
            tone="neutral"
          />
          <OverviewStatCard
            label="Last log"
            value={formatRelativeTime(latestLogAt)}
            detail={frameStatusText(frameWithLatestLog)}
            tone={stale ? 'warning' : 'neutral'}
          />
          <OverviewStatCard
            label="Render interval"
            value={`${frame.interval}s`}
            detail={`Metrics every ${frame.metrics_interval}s`}
          />
          <OverviewStatCard
            label="Storage"
            value={frame.save_assets ? 'Assets saved' : 'Assets transient'}
            detail={frame.assets_path || 'Default path'}
            tone="neutral"
          />
        </div>

        <div className="grid gap-4 @md:grid-cols-2 @6xl:grid-cols-4">
          <div className="frame-tool-card rounded-[22px] p-4">
            <div className="frame-tool-heading mb-3 font-semibold">Runtime</div>
            <div className="grid gap-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="frame-tool-muted">Host</span>
                <span className="truncate font-semibold">{frameHost(frame)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="frame-tool-muted">Display</span>
                <span className="font-semibold">
                  {frame.width && frame.height ? `${frame.width}x${frame.height}` : 'Unknown'}
                  {frame.rotate ? `, ${frame.rotate}deg` : ''}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="frame-tool-muted">Version</span>
                <span className="truncate font-semibold">{frame.version || 'Unknown'}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="frame-tool-muted">Last deploy</span>
                <span className="truncate font-semibold">{formatRelativeTime(frame.last_successful_deploy_at)}</span>
              </div>
            </div>
          </div>

          <OverviewSystemMetricTiles frame={frame} metrics={metrics} metricsLoading={metricsLoading} />
        </div>

        <div className="h-[28rem] min-h-[20rem]">
          <Logs />
        </div>
      </div>

      <div className="space-y-5">
        <OverviewScheduleCard frame={frame} scenes={scenes} />
        <div className="frame-tool-card overflow-hidden rounded-[22px]">
          <div
            className={clsx('frameos-card-media bg-slate-100', frameAspectRatio ? 'w-full' : 'h-64')}
            style={frameAspectRatio ? { aspectRatio: frameAspectRatio } : undefined}
          >
            <FrameImage frameId={frame.id} refreshable objectFit="contain" className="h-full w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

function FrameToolSurface({
  activeTool,
  frame,
  scenes,
  totalScenes,
  pageScroll,
}: {
  activeTool: WorkspaceUtilityPanel
  frame: FrameType
  scenes: FrameScene[]
  totalScenes: number
  pageScroll: boolean
}): JSX.Element {
  if (activeTool === 'overview') {
    return <FrameDashboardSurface frame={frame} scenes={scenes} totalScenes={totalScenes} />
  }
  if (activeTool === 'logs') return <Logs fullScreen />
  if (activeTool === 'metrics') return <Metrics scrollContainer={!pageScroll} />
  if (activeTool === 'assets') return <Assets scrollContainer={!pageScroll} />
  if (activeTool === 'terminal') return <Terminal />
  if (activeTool === 'settings') return <FrameSettings scrollContainer={!pageScroll} />
  if (activeTool === 'schedule') return <Schedule scrollContainer={!pageScroll} />
  if (activeTool === 'ping') return <Ping scrollContainer={!pageScroll} />
  if (activeTool === 'debug') return <Debug scrollContainer={!pageScroll} />
  return <Image className="h-full min-h-[26rem] w-full" objectFit="contain" />
}

function frameToolIsFullBleed(activeTool: WorkspaceUtilityPanel): boolean {
  return activeTool === 'overview' || activeTool === 'preview' || activeTool === 'logs' || activeTool === 'terminal'
}

function frameToolUsesPageScroll(activeTool: WorkspaceUtilityPanel): boolean {
  return activeTool !== 'preview'
}

function ScheduleDrawer({ frame }: { frame: FrameType }): JSX.Element {
  const { closeScheduleDrawer } = useActions(workspaceLogic)
  const frameLogicProps = { frameId: frame.id }

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 w-[430px] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <BindLogic logic={frameLogic} props={frameLogicProps}>
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
            <Schedule scrollContainer={false} drawerMode />
          </div>
        </div>
      </BindLogic>
    </div>
  )
}

function FrameWorkspaceForFrame({ frameId }: { frameId: number }): JSX.Element {
  const frameLogicProps = { frameId }
  useMountedLogic(terminalLogic(frameLogicProps))
  useMountedLogic(frameSettingsLogic(frameLogicProps))
  useMountedLogic(logsLogic(frameLogicProps))
  useMountedLogic(metricsLogic(frameLogicProps))

  const { framesList } = useValues(framesModel)
  const { frame, scenes } = useValues(frameLogic(frameLogicProps))
  const {
    sceneControlSelection,
    scheduleDrawerFrameId,
    templateDrawerFrameId,
    utilityPanel,
    frameToolScrollPositions,
  } = useValues(workspaceLogic)
  const { rememberFrameToolScroll } = useActions(workspaceLogic)
  const activeTool =
    frameToolDefinitions.find((definition) => definition.panel === utilityPanel) ?? frameToolDefinitions[0]
  const activeToolPanel = activeTool.panel
  const activeToolScrollKey = frameToolScrollKey(frameId, activeToolPanel)
  const frameToolScrollPositionsRef = useRef(frameToolScrollPositions)
  const lastObservedFrameToolScrollTopRef = useRef(0)
  const visibleScenes = scenes
  const frameLoaded = !!frame
  const toolUsesSearch = false
  const toolUsesPageScroll = frameToolUsesPageScroll(activeToolPanel)

  frameToolScrollPositionsRef.current = frameToolScrollPositions

  const rememberFrameToolScrollTop = useCallback(
    (scrollTop: number) => {
      const nextScrollTop = Math.max(0, Math.round(scrollTop))
      frameToolScrollPositionsRef.current = {
        ...frameToolScrollPositionsRef.current,
        [frameToolScrollKey(frameId, activeToolPanel)]: nextScrollTop,
      }
      rememberFrameToolScroll(frameId, activeToolPanel, nextScrollTop)
    },
    [activeToolPanel, frameId, rememberFrameToolScroll]
  )

  useLayoutEffect(() => {
    return () => {
      rememberFrameToolScrollTop(lastObservedFrameToolScrollTopRef.current)
    }
  }, [rememberFrameToolScrollTop])

  useLayoutEffect(() => {
    if (!frameLoaded || typeof window === 'undefined') {
      return
    }

    const restoredScrollTop = frameToolInitialScrollTop(frameToolScrollPositionsRef.current, frameId, activeToolPanel)
    if (restoredScrollTop === null) {
      return
    }

    lastObservedFrameToolScrollTopRef.current = restoredScrollTop
    return restoreFrameToolScrollTop(restoredScrollTop)
  }, [activeToolScrollKey, activeToolPanel, frameId, frameLoaded])

  useLayoutEffect(() => {
    const target = frameToolScrollTarget()
    if (!target) {
      return
    }

    let scrollFrameId: number | null = null
    const handleScroll = () => {
      lastObservedFrameToolScrollTopRef.current = Math.max(0, Math.round(readFrameToolScrollTop()))
      if (scrollFrameId !== null || typeof window === 'undefined') {
        return
      }
      scrollFrameId = window.requestAnimationFrame(() => {
        scrollFrameId = null
        rememberFrameToolScrollTop(lastObservedFrameToolScrollTopRef.current)
      })
    }

    target.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      if (scrollFrameId !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(scrollFrameId)
      }
      target.removeEventListener('scroll', handleScroll)
    }
  }, [rememberFrameToolScrollTop])

  if (!frame) {
    return (
      <FrameosShell mode="frame" title="Frame" tree={<div className="px-3 py-2 text-slate-400">Loading...</div>}>
        <div className="flex h-[60vh] items-center justify-center text-slate-500">Loading frame...</div>
      </FrameosShell>
    )
  }

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      <BindLogic logic={panelsLogic} props={frameLogicProps}>
        <FrameosShell
          mode="frame"
          title="Frame"
          tree={<FrameTree frame={frame} frames={framesList} activeTool={activeToolPanel} />}
          topBar={toolUsesSearch ? undefined : null}
          showAiButton={false}
          mainClassName={clsx(
            toolUsesPageScroll ? 'min-h-screen overflow-visible' : 'h-screen overflow-hidden',
            'frame-workspace-main py-6 pr-8 max-lg:h-auto max-lg:overflow-visible max-lg:px-4 max-lg:pb-6 max-lg:pt-0'
          )}
          rightPanel={
            templateDrawerFrameId ? (
              <TemplateDrawer />
            ) : scheduleDrawerFrameId === frame.id ? (
              <FrameScheduleDrawer frame={frame} />
            ) : sceneControlSelection ? (
              <SceneControlPanel />
            ) : null
          }
        >
          <div className={toolUsesPageScroll ? undefined : 'h-full'}>
            <div
              className={clsx(
                toolUsesPageScroll
                  ? 'min-h-[32rem]'
                  : [toolUsesSearch ? 'h-[calc(100vh-8rem)]' : 'h-[calc(100vh-3rem)]', 'max-lg:h-auto'],
                toolUsesPageScroll
                  ? 'overflow-visible'
                  : frameToolIsFullBleed(activeToolPanel)
                  ? 'overflow-hidden'
                  : 'overflow-y-auto'
              )}
            >
              <FrameToolSurface
                activeTool={activeToolPanel}
                frame={frame}
                scenes={visibleScenes}
                totalScenes={scenes.length}
                pageScroll={toolUsesPageScroll}
              />
            </div>
          </div>
        </FrameosShell>
      </BindLogic>
    </BindLogic>
  )
}

export function FrameWorkspace({ id }: FrameWorkspaceProps): JSX.Element {
  useMountedLogic(sceneWorkspaceLogic({ routeFrameId: id ?? null, routeSceneId: null }))
  const { selectedFrame } = useValues(workspaceLogic)
  const { activeFramesList, framesList } = useValues(framesModel)
  const routeFrameId = parseFrameId(id)
  const firstFrame =
    (routeFrameId ? framesList.find((frame) => frame.id === routeFrameId) : null) ??
    selectedFrame ??
    activeFramesList[0] ??
    framesList[0] ??
    null

  if (!firstFrame) {
    return (
      <FrameosShell
        mode="frame"
        title="Frame"
        subtitle="No frames"
        tree={<div className="px-3 py-2 text-slate-400">Add a frame before opening frame tools.</div>}
      >
        <div className="flex h-[60vh] items-center justify-center rounded-[24px] border border-white/80 bg-white/55 text-slate-500 shadow-lg shadow-slate-300/25">
          No frames available.
        </div>
      </FrameosShell>
    )
  }

  return <FrameWorkspaceForFrame frameId={firstFrame.id} />
}

export default FrameWorkspace
