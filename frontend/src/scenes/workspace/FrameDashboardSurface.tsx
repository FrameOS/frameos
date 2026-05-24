import { BindLogic, useActions, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import type { CSSProperties, DragEvent } from 'react'
import {
  AdjustmentsHorizontalIcon,
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  CircleStackIcon,
  CommandLineIcon,
  ComputerDesktopIcon,
  DocumentTextIcon,
  EyeIcon,
  PencilSquareIcon,
  PlusIcon,
  RocketLaunchIcon,
  SignalIcon,
  SparklesIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'

import { DropdownMenu } from '../../components/DropdownMenu'
import { FrameImage } from '../../components/FrameImage'
import { frameHost, frameIsHealthy, frameStatus } from '../../decorators/frame'
import { framesModel } from '../../models/framesModel'
import { urls } from '../../urls'
import type { FrameScene, FrameType, ScheduledEvent } from '../../types'
import { frameLogic } from '../frame/frameLogic'
import { HeaderMetrics } from '../frame/panels/Metrics/HeaderMetrics'
import { Schedule } from '../frame/panels/Schedule/Schedule'
import { controlLogic } from '../frame/panels/Scenes/controlLogic'
import { SceneDropDown } from '../frame/panels/Scenes/SceneDropDown'
import { newFrameForm } from '../frames/newFrameForm'
import { FrameLiveBadge } from './FrameLiveBadge'
import { getFrameosSceneDragData, hasFrameosSceneDragData, setFrameosSceneDragData } from './sceneDrag'
import { workspaceLogic } from './workspaceLogic'

const uploadedScenePrefix = 'uploaded/'
const activeSurfaceClassName = 'border-[#4a4b8c] shadow-[0_0_3px_3px_rgba(128,0,255,0.5)]'
const sceneTileWidthRem = 9
const sceneTileGapRem = 1
const framePreviewMaxHeightRem = 32
const framePreviewMaxWidthRem = sceneTileWidthRem * 2 + sceneTileGapRem
const sceneToolButtons = [
  { label: 'Logs', panel: 'logs', icon: DocumentTextIcon },
  { label: 'Metrics', panel: 'metrics', icon: ChartBarIcon },
  { label: 'Assets', panel: 'assets', icon: CircleStackIcon },
  { label: 'Terminal', panel: 'terminal', icon: CommandLineIcon },
  { label: 'Ping', panel: 'ping', icon: SignalIcon },
  { label: 'Settings', panel: 'settings', icon: AdjustmentsHorizontalIcon },
] as const

interface FrameDashboardSurfaceProps {
  frame: FrameType
  scenes: FrameScene[]
  totalScenes?: number
  archived?: boolean
  frameMatchesSearch?: boolean
  sectionId?: string
  showSceneMenus?: boolean
}

export function sceneIsActive(scene: FrameScene, currentSceneId: string | null | undefined): boolean {
  return currentSceneId === scene.id || currentSceneId === `${uploadedScenePrefix}${scene.id}`
}

function frameDisplayDimensions(frame: FrameType): { width: number; height: number } | null {
  if (!frame.width || !frame.height) {
    return null
  }
  return frame.rotate === 90 || frame.rotate === 270
    ? { width: frame.height, height: frame.width }
    : { width: frame.width, height: frame.height }
}

function framePreviewSizing(frame: FrameType): { imageStyle: CSSProperties; cardStyle: CSSProperties } | null {
  const dimensions = frameDisplayDimensions(frame)
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return null
  }

  const ratio = dimensions.width / dimensions.height
  const maxWidth = Math.min(framePreviewMaxWidthRem, framePreviewMaxHeightRem * ratio)

  return {
    imageStyle: { aspectRatio: `${dimensions.width} / ${dimensions.height}` },
    cardStyle: { maxWidth: `${maxWidth.toFixed(3)}rem` },
  }
}

function sceneDisplayName(scene: FrameScene | null | undefined, fallback = 'Untitled scene'): string {
  return scene?.name || fallback
}

function scheduleTimeLabel(event: ScheduledEvent): string {
  return `${String(event.hour).padStart(2, '0')}:${String(event.minute).padStart(2, '0')}`
}

function eventRunsOnDate(event: ScheduledEvent, date: Date): boolean {
  const weekday = event.weekday || 0
  const jsDay = date.getDay()
  const mondayBasedDay = jsDay === 0 ? 7 : jsDay

  if (!weekday) {
    return true
  }
  if (weekday === 8) {
    return mondayBasedDay >= 1 && mondayBasedDay <= 5
  }
  if (weekday === 9) {
    return mondayBasedDay === 6 || mondayBasedDay === 7
  }
  return weekday === mondayBasedDay
}

function nextScheduledEvent(
  schedule: FrameType['schedule'],
  now = new Date()
): { event: ScheduledEvent; date: Date } | null {
  if (!schedule || schedule.disabled) {
    return null
  }

  let next: { event: ScheduledEvent; date: Date } | null = null
  const enabledEvents = (schedule.events ?? []).filter((event) => !event.disabled)

  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const day = new Date(now)
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() + dayOffset)

    for (const event of enabledEvents) {
      if (!eventRunsOnDate(event, day)) {
        continue
      }

      const hour = Number(event.hour)
      const minute = Number(event.minute)
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
        continue
      }

      const date = new Date(day)
      date.setHours(hour, minute, 0, 0)
      if (date.getTime() <= now.getTime()) {
        continue
      }
      if (!next || date.getTime() < next.date.getTime()) {
        next = { event, date }
      }
    }
  }

  return next
}

function scheduleDatePrefix(date: Date, now = new Date()): string {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const target = new Date(date)
  target.setHours(0, 0, 0, 0)
  const daysAway = Math.round((target.getTime() - today.getTime()) / 86400000)

  if (daysAway === 0) {
    return 'scheduled at'
  }
  if (daysAway === 1) {
    return 'scheduled tomorrow at'
  }
  return `scheduled ${target.toLocaleDateString(undefined, { weekday: 'long' })} at`
}

function FramePreviewPanel({ frame, scenes }: { frame: FrameType; scenes: FrameScene[] }): JSX.Element {
  const previewSizing = framePreviewSizing(frame)
  const { openScheduleDrawer } = useActions(workspaceLogic)
  const { sceneId: currentSceneId } = useValues(controlLogic({ frameId: frame.id }))
  const activeScene = scenes.find((scene) => sceneIsActive(scene, currentSceneId))
  const nextSchedule = nextScheduledEvent(frame.schedule)
  const scheduledScene = nextSchedule ? scenes.find((scene) => scene.id === nextSchedule.event.payload.sceneId) : null

  return (
    <div
      className="frameos-card group w-full min-w-0 justify-self-start overflow-hidden rounded-lg border border-white/90 bg-white text-left shadow-xl shadow-slate-300/35 transition hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-slate-300/45"
      style={previewSizing?.cardStyle ?? { maxWidth: `${framePreviewMaxWidthRem}rem` }}
    >
      <A
        href={urls.frame(frame.id, 'preview')}
        className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <div
          className={clsx(
            'frameos-card-media relative flex w-full min-h-0 items-center justify-center bg-slate-100',
            !previewSizing && 'h-64 max-h-[32rem]'
          )}
          style={previewSizing?.imageStyle}
        >
          <FrameImage
            frameId={frame.id}
            refreshable={false}
            objectFit="contain"
            className="h-full w-full rounded-none"
          />
          <FrameLiveBadge frame={frame} className="right-3 top-3" />
        </div>
      </A>
      <div className="frameos-divider flex items-start justify-between gap-3 border-t border-slate-200/80 px-3 py-3">
        <div className="min-w-0 text-sm">
          <div className="frameos-strong truncate font-semibold text-slate-800">
            {activeScene ? sceneDisplayName(activeScene) : 'current image'}
          </div>
          <div className="frameos-muted mt-1 truncate text-xs text-slate-500">
            {nextSchedule
              ? `${scheduleDatePrefix(nextSchedule.date)} ${scheduleTimeLabel(nextSchedule.event)}: ${sceneDisplayName(
                  scheduledScene,
                  'Unknown scene'
                )}`
              : 'nothing scheduled'}
          </div>
        </div>
        <button
          type="button"
          title="Edit schedule"
          aria-label="Edit schedule"
          onClick={() => openScheduleDrawer(frame.id)}
          className="frameos-secondary-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/80 text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <CalendarDaysIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

function FrameHeaderActions({ frame, archived }: { frame: FrameType; archived?: boolean }): JSX.Element {
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
      <HeaderMetrics frameId={frame.id} />
      <button
        type="button"
        onClick={() => openScheduleDrawer(frame.id)}
        className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <CalendarDaysIcon className="h-5 w-5" />
        Schedule
      </button>
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

function FrameDashboardHeader({ frame, archived }: { frame: FrameType; archived?: boolean }): JSX.Element {
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
      <FrameHeaderActions frame={frame} archived={archived} />
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
      data-workspace-scene-tile={scene.id}
      data-workspace-scene-tile-frame={frame.id}
      onDragStart={(event) => setFrameosSceneDragData(event.dataTransfer, scene.id)}
      className={clsx(
        'frameos-card group relative h-36 w-36 shrink-0 overflow-hidden rounded-lg border bg-white text-left transition hover:-translate-y-0.5 focus-within:ring-2 focus-within:ring-blue-400',
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
  const { templateDrawerFrameId } = useValues(workspaceLogic)
  const { hideForm } = useActions(newFrameForm)
  const { closeSceneControl, openTemplateDrawer } = useActions(workspaceLogic)
  const active = templateDrawerFrameId === frame.id

  return (
    <button
      type="button"
      onClick={() => {
        hideForm()
        closeSceneControl()
        openTemplateDrawer(frame.id)
      }}
      className={clsx(
        'frameos-primary-hover-text frameos-card group flex shrink-0 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-white/55 text-center text-slate-500 shadow-sm transition hover:-translate-y-0.5 hover:bg-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active
          ? `${activeSurfaceClassName} hover:shadow-[0_0_4px_4px_rgba(128,0,255,0.55)]`
          : 'border-slate-300 hover:shadow-lg hover:shadow-slate-300/35',
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
    <div className="min-w-0" onDragOver={handleScenesDragOver} onDrop={handleScenesDrop}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {sceneToolButtons.map(({ label, panel, icon: Icon }) => (
          <A
            key={panel}
            href={urls.frame(frame.id, panel)}
            className="frameos-secondary-button inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/80 px-2.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <Icon className="h-4 w-4" />
            {label}
          </A>
        ))}
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
        <div className="frameos-empty flex h-40 min-w-64 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white/45 px-6 text-center text-sm font-medium text-slate-500">
          Frame matched. No scenes match this search.
        </div>
      ) : search.trim() && totalScenes > 0 ? (
        <div className="frameos-empty flex h-40 min-w-64 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white/45 px-6 text-center text-sm font-medium text-slate-500">
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
  showSceneMenus = false,
}: FrameDashboardSurfaceProps): JSX.Element {
  return (
    <section
      id={sectionId}
      data-workspace-frame-section={frame.id}
      className={clsx('group @container scroll-mt-6', archived && 'opacity-80')}
    >
      <FrameDashboardHeader frame={frame} archived={archived} />
      <div className="grid gap-5 @2xl:grid-cols-[minmax(0,19rem)_minmax(19rem,1fr)] @2xl:items-start">
        <FramePreviewPanel frame={frame} scenes={scenes} />
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
