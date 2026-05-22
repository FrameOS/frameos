import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import {
  AdjustmentsHorizontalIcon,
  BoltIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  CircleStackIcon,
  CommandLineIcon,
  DocumentTextIcon,
  EyeIcon,
  PhotoIcon,
  SignalIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'
import { frameHost, frameIsHealthy, frameIsStale } from '../../decorators/frame'
import { FrameImage } from '../../components/FrameImage'
import { FrameScene, FrameType, LogType } from '../../types'
import { framesModel } from '../../models/framesModel'
import { insertBreaks } from '../../utils/insertBreaks'
import { HomeyShell } from './HomeyShell'
import { AddSceneTile, SceneControlPanel, TemplateDrawer } from './FramesHome'
import { sceneWorkspaceLogic } from './sceneWorkspaceLogic'
import { workspaceLogic, WorkspaceUtilityPanel } from './workspaceLogic'
import { urls } from '../../urls'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { assetsLogic } from '../frame/panels/Assets/assetsLogic'
import { terminalLogic } from '../frame/panels/Terminal/terminalLogic'
import { frameSettingsLogic } from '../frame/panels/FrameSettings/frameSettingsLogic'
import { logsLogic } from '../frame/panels/Logs/logsLogic'
import { metricsLogic } from '../frame/panels/Metrics/metricsLogic'
import { Assets } from '../frame/panels/Assets/Assets'
import { Debug } from '../frame/panels/Debug/Debug'
import { FrameSettings } from '../frame/panels/FrameSettings/FrameSettings'
import { Image } from '../frame/panels/Image/Image'
import { Logs } from '../frame/panels/Logs/Logs'
import { Metrics } from '../frame/panels/Metrics/Metrics'
import { Ping } from '../frame/panels/Ping/Ping'
import { Schedule } from '../frame/panels/Schedule/Schedule'
import { Terminal } from '../frame/panels/Terminal/Terminal'

interface FrameWorkspaceProps {
  id?: string
}

interface FrameToolDefinition {
  panel: WorkspaceUtilityPanel
  label: string
  description: string
  icon: JSX.Element
}

const frameToolDefinitions: FrameToolDefinition[] = [
  {
    panel: 'overview',
    label: 'Overview',
    description: 'Health dashboard',
    icon: <Squares2X2Icon className="h-5 w-5" />,
  },
  { panel: 'scenes', label: 'Scenes', description: 'Frame scenes', icon: <PhotoIcon className="h-5 w-5" /> },
  { panel: 'preview', label: 'Live view', description: 'Current image', icon: <EyeIcon className="h-5 w-5" /> },
  { panel: 'logs', label: 'Logs', description: 'Runtime output', icon: <DocumentTextIcon className="h-5 w-5" /> },
  { panel: 'metrics', label: 'Metrics', description: 'Health charts', icon: <ChartBarIcon className="h-5 w-5" /> },
  { panel: 'assets', label: 'Assets', description: 'Files on frame', icon: <CircleStackIcon className="h-5 w-5" /> },
  { panel: 'terminal', label: 'Terminal', description: 'Shell access', icon: <CommandLineIcon className="h-5 w-5" /> },
  {
    panel: 'schedule',
    label: 'Schedule',
    description: 'Scene changes',
    icon: <CalendarDaysIcon className="h-5 w-5" />,
  },
  { panel: 'ping', label: 'Ping', description: 'Connectivity', icon: <SignalIcon className="h-5 w-5" /> },
  { panel: 'debug', label: 'Debug', description: 'Diagnostics', icon: <BoltIcon className="h-5 w-5" /> },
  {
    panel: 'settings',
    label: 'Settings',
    description: 'Frame config',
    icon: <AdjustmentsHorizontalIcon className="h-5 w-5" />,
  },
]

function parseFrameId(frameId?: string): number | null {
  if (!frameId) {
    return null
  }
  const parsed = parseInt(frameId, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function FrameSelector({ frame, frames }: { frame: FrameType; frames: FrameType[] }): JSX.Element {
  const { navigateToFrame } = useActions(workspaceLogic)

  return (
    <div className="px-2">
      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">Frame</label>
      <select
        value={frame.id}
        onChange={(event) => navigateToFrame(parseInt(event.target.value, 10))}
        className="homey-form-control w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-400"
      >
        {frames.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.name || frameHost(candidate)}
          </option>
        ))}
      </select>
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
        'homey-frame-tool-row flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active ? 'homey-frame-tool-row-selected bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
      )}
    >
      <span
        className={clsx(
          'homey-frame-tool-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
          active ? 'bg-white/12 text-white' : 'bg-slate-100 text-slate-500'
        )}
      >
        {definition.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{definition.label}</span>
        <span
          className={clsx(
            'homey-frame-tool-description block truncate text-xs',
            active ? 'text-slate-300' : 'text-slate-400'
          )}
        >
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
      <div>
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Frame Tools</div>
        <div className="space-y-1">
          {frameToolDefinitions.map((definition) => (
            <FrameToolRow
              key={definition.panel}
              definition={definition}
              active={activeTool === definition.panel}
              frameId={frame.id}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function SceneTile({ frame, scene }: { frame: FrameType; scene: FrameScene }): JSX.Element {
  const { openSceneControl } = useActions(workspaceLogic)
  const fieldCount = scene.fields?.filter((field) => field.access === 'public').length ?? 0

  return (
    <button
      type="button"
      onClick={() => openSceneControl(frame.id, scene.id)}
      className="homey-card group flex h-36 w-36 shrink-0 flex-col overflow-hidden rounded-2xl border border-white/90 bg-white text-left shadow-lg shadow-slate-300/35 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-300/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <div className="homey-card-media relative flex min-h-0 flex-1 items-center justify-center bg-slate-100">
        <FrameImage
          frameId={frame.id}
          sceneId={scene.id}
          thumb
          refreshable={false}
          objectFit="cover"
          className="h-full w-full rounded-none"
        />
        <div className="absolute right-2 top-2 rounded-full bg-white/90 p-1 text-slate-400 shadow-sm transition group-hover:text-blue-500">
          <PlayIcon className="h-4 w-4" />
        </div>
      </div>
      <div className="w-full px-3 py-2">
        <div className="homey-strong truncate text-sm font-semibold text-slate-900">
          {scene.name || 'Untitled scene'}
        </div>
        <div className="homey-muted mt-0.5 truncate text-xs text-slate-500">
          {scene.nodes?.length ?? 0} nodes
          {fieldCount > 0 ? ` · ${fieldCount} controls` : ''}
        </div>
      </div>
    </button>
  )
}

function CurrentSnapshotTile({ frame }: { frame: FrameType }): JSX.Element {
  return (
    <A
      href={urls.frame(frame.id, 'preview')}
      className="homey-card group flex w-[22rem] max-w-full shrink-0 flex-col overflow-hidden rounded-[22px] border border-white/90 bg-white text-left shadow-xl shadow-slate-300/35 transition hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-slate-300/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <div className="homey-card-media relative flex h-52 items-center justify-center bg-slate-100">
        <FrameImage frameId={frame.id} refreshable={false} objectFit="contain" className="h-full w-full" />
        <div className="absolute right-3 top-3 rounded-full bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-500 shadow-sm transition group-hover:text-blue-500">
          Open
        </div>
      </div>
      <div className="px-4 py-3">
        <div className="homey-muted text-xs text-slate-500">
          Last rendered image from {frame.name || frameHost(frame)}
        </div>
      </div>
    </A>
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

  if (scenes.length === 0) {
    if (totalScenes > 0 && search.trim()) {
      return (
        <div className="flex items-start gap-5 max-xl:flex-col">
          <CurrentSnapshotTile frame={frame} />
          <div className="homey-empty flex h-40 min-w-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/45 px-6 text-center text-sm font-medium text-slate-500">
            No scenes match this search.
          </div>
        </div>
      )
    }

    return (
      <div className="flex items-start gap-5 max-xl:flex-col">
        <CurrentSnapshotTile frame={frame} />
        <AddSceneTile frame={frame} compact />
      </div>
    )
  }

  return (
    <div className="flex items-start gap-5 max-xl:flex-col">
      <CurrentSnapshotTile frame={frame} />
      <div className="flex flex-wrap gap-4">
        {scenes.map((scene) => (
          <SceneTile key={scene.id} frame={frame} scene={scene} />
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

function formatLogTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  return `${date.getFullYear()}-${date.getMonth() + 1 < 10 ? '0' : ''}${date.getMonth() + 1}-${
    date.getDate() < 10 ? '0' : ''
  }${date.getDate()} ${date.getHours() < 10 ? '0' : ''}${date.getHours()}:${
    date.getMinutes() < 10 ? '0' : ''
  }${date.getMinutes()}:${date.getSeconds() < 10 ? '0' : ''}${date.getSeconds()}`
}

function renderOverviewLogLine(log: LogType): string | JSX.Element {
  if (log.type === 'webhook') {
    try {
      const { event, timestamp, ...rest } = JSON.parse(log.line) as {
        event?: string
        timestamp?: unknown
        [key: string]: unknown
      }
      const entries = Object.entries(rest)
      if (event || entries.length > 0) {
        return (
          <>
            {event ? <span className="mr-2 text-yellow-300">{event}</span> : null}
            {entries.map(([key, value]) => {
              const formattedValue = value === undefined ? 'undefined' : JSON.stringify(value)
              return (
                <span key={key} className="mr-2">
                  <span className="text-slate-500">{key}=</span>
                  <span>{insertBreaks(formattedValue ?? 'null')}</span>
                </span>
              )
            })}
          </>
        )
      }
    } catch (error) {}
  } else if (log.type === 'agent') {
    return (
      <>
        <span className="text-blue-300">{'[AGENT]'}</span> {log.line}
      </>
    )
  }
  return log.line
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
      : 'text-blue-500'

  return (
    <div className="frame-tool-card rounded-[22px] p-4">
      <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{label}</div>
      <div className={clsx('mt-2 truncate text-2xl font-bold tracking-normal', toneClassName)}>{value}</div>
      {detail ? <div className="frame-tool-muted mt-1 truncate text-sm">{detail}</div> : null}
    </div>
  )
}

function FrameOverviewSurface({ frame, scenes }: { frame: FrameType; scenes: FrameScene[] }): JSX.Element {
  const { logs, logsLoading } = useValues(logsLogic({ frameId: frame.id }))
  const { metrics, metricsLoading, latestMetricSummariesByCategory } = useValues(metricsLogic({ frameId: frame.id }))
  const stale = frameIsStale(frame)
  const healthy = frameIsHealthy(frame)
  const connected = (frame.active_connections ?? 0) > 0
  const recentLogs = logs.slice(-6).reverse()
  const healthTone = healthy ? 'good' : stale ? 'warning' : frame.status === 'error' ? 'danger' : 'neutral'
  const metricsSummaries = Object.entries(latestMetricSummariesByCategory)
  const frameAspectRatio =
    frame.width && frame.height
      ? frame.rotate === 90 || frame.rotate === 270
        ? `${frame.height} / ${frame.width}`
        : `${frame.width} / ${frame.height}`
      : null

  return (
    <div className="frame-tool-panel grid h-full min-h-0 content-start gap-x-5 gap-y-3 overflow-y-auto pr-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)]">
      <header className="min-w-0 xl:col-span-2">
        <h1 className="homey-strong truncate text-4xl font-bold leading-tight tracking-normal text-slate-950 max-md:text-3xl">
          {frame.name || frameHost(frame)}
        </h1>
      </header>
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <OverviewStatCard
            label="Health"
            value={healthy ? 'Healthy' : stale ? 'Stale' : frame.status}
            tone={healthTone}
          />
          <OverviewStatCard
            label="Connection"
            value={connected ? 'Connected' : 'Offline'}
            detail={`${frame.active_connections ?? 0} active`}
            tone={connected ? 'good' : 'warning'}
          />
          <OverviewStatCard
            label="Scenes"
            value={String(scenes.length)}
            detail={scenes.length === 1 ? '1 scene configured' : `${scenes.length} scenes configured`}
            tone="neutral"
          />
          <OverviewStatCard
            label="Last log"
            value={formatRelativeTime(frame.last_log_at)}
            detail={frameStatusText(frame)}
            tone={stale ? 'warning' : 'neutral'}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
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

          <div className="frame-tool-card rounded-[22px] p-4">
            <div className="frame-tool-heading mb-3 font-semibold">Metrics</div>
            {metricsLoading ? (
              <div className="frame-tool-muted text-sm">Loading metrics...</div>
            ) : metrics.length === 0 ? (
              <div className="frame-tool-muted text-sm">No metrics yet.</div>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="frame-tool-muted">Points</span>
                  <span className="font-semibold">{metrics.length}</span>
                </div>
                {metricsSummaries.length > 0 ? (
                  metricsSummaries.map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-3">
                      <span className="frame-tool-muted">{key}</span>
                      <span className="truncate font-semibold">{value}</span>
                    </div>
                  ))
                ) : (
                  <div className="frame-tool-muted">Recent metrics are available.</div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="frame-tool-terminal rounded-[22px] p-3">
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <A
              href={urls.frame(frame.id, 'logs')}
              className="font-semibold text-white transition hover:text-blue-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Recent logs
            </A>
            <div className="text-xs text-slate-500">{logsLoading ? 'Loading...' : `${logs.length} loaded`}</div>
          </div>
          {recentLogs.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-sm text-slate-500">No logs yet.</div>
          ) : (
            <div className="font-mono text-xs leading-4">
              {recentLogs.map((log) => (
                <div
                  key={log.id}
                  className={clsx('rounded-lg px-2 py-0.5 text-slate-300 transition sm:flex sm:flex-row', {
                    'text-yellow-300': log.type === 'stdinfo',
                    'text-red-300': log.type === 'stderr',
                    'text-blue-300': log.type === 'agent',
                    'text-yellow-200': log.type === 'build',
                  })}
                >
                  <div className="flex-0 mr-3 whitespace-nowrap text-slate-500">
                    {formatLogTimestamp(log.timestamp)}
                  </div>
                  <div className="min-w-0 flex-1 break-words" style={{ wordBreak: 'break-word' }}>
                    {renderOverviewLogLine(log)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-5">
        <div className="frame-tool-card overflow-hidden rounded-[22px]">
          <div
            className={clsx('homey-card-media bg-slate-100', frameAspectRatio ? 'w-full' : 'h-64')}
            style={frameAspectRatio ? { aspectRatio: frameAspectRatio } : undefined}
          >
            <FrameImage frameId={frame.id} refreshable objectFit="contain" className="h-full w-full" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
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
      </div>
    </div>
  )
}

function FrameToolSurface({
  activeTool,
  frame,
  scenes,
  totalScenes,
}: {
  activeTool: WorkspaceUtilityPanel
  frame: FrameType
  scenes: FrameScene[]
  totalScenes: number
}): JSX.Element {
  if (activeTool === 'overview') return <FrameOverviewSurface frame={frame} scenes={scenes} />
  if (activeTool === 'scenes') return <FrameScenesSurface frame={frame} scenes={scenes} totalScenes={totalScenes} />
  if (activeTool === 'logs') return <Logs />
  if (activeTool === 'metrics') return <Metrics />
  if (activeTool === 'assets') return <Assets />
  if (activeTool === 'terminal') return <Terminal />
  if (activeTool === 'settings') return <FrameSettings />
  if (activeTool === 'schedule') return <Schedule />
  if (activeTool === 'ping') return <Ping />
  if (activeTool === 'debug') return <Debug />
  return <Image className="h-full min-h-[26rem]" />
}

function frameToolIsFullBleed(activeTool: WorkspaceUtilityPanel): boolean {
  return activeTool === 'overview' || activeTool === 'preview' || activeTool === 'logs' || activeTool === 'terminal'
}

function frameToolUsesWorkspaceSearch(activeTool: WorkspaceUtilityPanel): boolean {
  return activeTool === 'scenes'
}

function FrameWorkspaceForFrame({ frameId }: { frameId: number }): JSX.Element {
  const frameLogicProps = { frameId }
  useMountedLogic(assetsLogic(frameLogicProps))
  useMountedLogic(terminalLogic(frameLogicProps))
  useMountedLogic(frameSettingsLogic(frameLogicProps))
  useMountedLogic(logsLogic(frameLogicProps))
  useMountedLogic(metricsLogic(frameLogicProps))

  const { framesList } = useValues(framesModel)
  const { frame, scenes } = useValues(frameLogic(frameLogicProps))
  const { filteredSelectedFrameScenes, sceneControlSelection, templateDrawerFrameId, utilityPanel } =
    useValues(workspaceLogic)
  const activeTool =
    frameToolDefinitions.find((definition) => definition.panel === utilityPanel) ?? frameToolDefinitions[0]
  const visibleScenes = activeTool.panel === 'scenes' ? filteredSelectedFrameScenes : scenes
  const toolUsesSearch = frameToolUsesWorkspaceSearch(activeTool.panel)

  if (!frame) {
    return (
      <HomeyShell mode="frame" title="Frame" tree={<div className="px-3 py-2 text-slate-400">Loading...</div>}>
        <div className="flex h-[60vh] items-center justify-center text-slate-500">Loading frame...</div>
      </HomeyShell>
    )
  }

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      <BindLogic logic={panelsLogic} props={frameLogicProps}>
        <HomeyShell
          mode="frame"
          title="Frame"
          tree={<FrameTree frame={frame} frames={framesList} activeTool={activeTool.panel} />}
          topBar={toolUsesSearch ? undefined : null}
          mainClassName="h-screen overflow-hidden py-6 pl-[480px] pr-8 max-lg:h-auto max-lg:overflow-visible max-lg:px-4 max-lg:pb-6 max-lg:pt-0"
          rightPanel={templateDrawerFrameId ? <TemplateDrawer /> : sceneControlSelection ? <SceneControlPanel /> : null}
        >
          <div className="h-full">
            <div
              className={clsx(
                toolUsesSearch ? 'h-[calc(100vh-8rem)]' : 'h-[calc(100vh-3rem)]',
                'min-h-[32rem] max-lg:h-auto',
                frameToolIsFullBleed(activeTool.panel) ? 'overflow-hidden' : 'overflow-y-auto'
              )}
            >
              <FrameToolSurface
                activeTool={activeTool.panel}
                frame={frame}
                scenes={visibleScenes}
                totalScenes={scenes.length}
              />
            </div>
          </div>
        </HomeyShell>
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
      <HomeyShell
        mode="frame"
        title="Frame"
        subtitle="No frames"
        tree={<div className="px-3 py-2 text-slate-400">Add a frame before opening frame tools.</div>}
      >
        <div className="flex h-[60vh] items-center justify-center rounded-[24px] border border-white/80 bg-white/55 text-slate-500 shadow-lg shadow-slate-300/25">
          No frames available.
        </div>
      </HomeyShell>
    )
  }

  return <FrameWorkspaceForFrame frameId={firstFrame.id} />
}

export default FrameWorkspace
