import { useActions, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import type { CSSProperties, DragEvent } from 'react'
import {
  AdjustmentsHorizontalIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  CircleStackIcon,
  CommandLineIcon,
  DocumentTextIcon,
  PlusIcon,
  SignalIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline'

import { FrameConnectionDot } from '../../components/FrameConnectionDot'
import { FrameImage } from '../../components/FrameImage'
import { frameHost, frameIsHealthy, frameStatus } from '../../decorators/frame'
import { urls } from '../../urls'
import type { FrameScene, FrameType, ScheduledEvent } from '../../types'
import { frameLogic } from '../frame/frameLogic'
import { HeaderMetrics } from '../frame/panels/Metrics/HeaderMetrics'
import { CompiledSceneTag } from '../frame/panels/Scenes/CompiledSceneTag'
import { templatesLogic } from '../frame/panels/Templates/templatesLogic'
import { newFrameForm } from '../frames/newFrameForm'
import { FrameActionsMenu } from './FrameActionsMenu'
import { FrameImageOverlayControls } from './FrameImageOverlayControls'
import { DeployToFrameIcon, FrameChangeStatusIcon } from './FrameChangeStatusIcon'
import { FrameLocalDeployMenu } from './FrameLocalDeployMenu'
import { FrameMetricAlertIndicator } from './FrameMetricAlertIndicator'
import { WorkspaceSceneDropDown } from './WorkspaceSceneDropDown'
import {
  FRAMEOS_TEMPLATE_DRAG_TYPE,
  getFrameosSceneDragData,
  getFrameosTemplateDragData,
  hasFrameosSceneListDragData,
  setFrameosSceneDragData,
} from './sceneDrag'
import { sceneTileSummaryLabel } from './sceneTileLabels'
import { SceneDependencyConnector } from './SceneDependencyConnector'
import { SceneDependencyFormatMenu } from './SceneDependencyFormatMenu'
import {
  sceneChildExpansionKey,
  sceneChildExpansionPath,
  sceneDependencyGroupingIsEnabled,
  workspaceLogic,
} from './workspaceLogic'
import { sceneIsCompiledForFrame } from '../../utils/sceneExecution'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import {
  buildSceneDependencyEntries,
  buildSceneDependencyGraph,
  flatSceneDependencyEntries,
} from './sceneDependencyGrouping'

const uploadedScenePrefix = 'uploaded/'
const livePreviewSceneId = '__live_preview__'
const activeSurfaceClassName = 'frameos-active-surface'
const selectedSurfaceClassName = 'frameos-selected-surface'
const sceneTileWidthRem = 9
const sceneTileGapRem = 1
const framePreviewMaxHeightRem = 32
const framePreviewMaxWidthRem = sceneTileWidthRem * 2 + sceneTileGapRem
const sceneToolButtons = [
  { label: 'Settings', panel: 'settings', icon: AdjustmentsHorizontalIcon },
  { label: 'Schedule', panel: 'schedule', icon: CalendarDaysIcon },
  { label: 'Logs', panel: 'logs', icon: DocumentTextIcon },
  { label: 'Metrics', panel: 'metrics', icon: ChartBarIcon },
  { label: 'Assets', panel: 'assets', icon: CircleStackIcon },
  { label: 'Terminal', panel: 'terminal', icon: CommandLineIcon },
  { label: 'Ping', panel: 'ping', icon: SignalIcon },
] as const
const frameAdminUnsupportedSceneToolPanels = new Set(['terminal', 'ping'])

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
  return sceneIdIsActive(scene.id, currentSceneId)
}

function sceneIdIsActive(sceneId: string, currentSceneId: string | null | undefined): boolean {
  return currentSceneId === sceneId || currentSceneId === `${uploadedScenePrefix}${sceneId}`
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

function sceneIsCompiled(scene: FrameScene, frameMode?: FrameType['mode'] | null): boolean {
  return sceneIsCompiledForFrame(scene, frameMode)
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
  const { sceneControlSelection } = useValues(workspaceLogic)
  const { openLiveSceneControl } = useActions(workspaceLogic)
  const previewSizing = framePreviewSizing(frame)
  const activeSceneId = frame.active_scene_id || null
  const liveSceneControlId = activeSceneId || livePreviewSceneId
  const activeScene = scenes.find((scene) => sceneIsActive(scene, activeSceneId))
  const previewSelected =
    sceneControlSelection?.frameId === frame.id &&
    (activeSceneId
      ? sceneIdIsActive(sceneControlSelection.sceneId, activeSceneId)
      : sceneControlSelection.sceneId === livePreviewSceneId) &&
    sceneControlSelection.source === 'preview'
  const nextSchedule = nextScheduledEvent(frame.schedule)
  const scheduledScene = nextSchedule ? scenes.find((scene) => scene.id === nextSchedule.event.payload.sceneId) : null
  const openLivePreview = (): void => {
    openLiveSceneControl(frame.id, liveSceneControlId)
  }

  return (
    <div
      className={clsx(
        'frameos-card group relative w-full min-w-0 justify-self-start overflow-hidden rounded-lg border bg-white text-left transition hover:-translate-y-0.5',
        previewSelected
          ? selectedSurfaceClassName
          : 'border-white/90 shadow-xl shadow-slate-300/35 hover:shadow-2xl hover:shadow-slate-300/45'
      )}
      style={previewSizing?.cardStyle ?? { maxWidth: `${framePreviewMaxWidthRem}rem` }}
    >
      <div
        className={clsx(
          'frameos-card-media relative flex w-full min-h-0 items-center justify-center bg-slate-100',
          !previewSizing && 'h-64 max-h-[32rem]'
        )}
        style={previewSizing?.imageStyle}
      >
        <FrameImage frameId={frame.id} refreshable={false} objectFit="contain" className="h-full w-full rounded-none" />
        <button
          type="button"
          aria-label="Open scene preview"
          onClick={openLivePreview}
          className="absolute inset-0 z-[1] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        />
        <FrameImageOverlayControls frame={frame} />
      </div>
      <div className="frameos-divider border-t border-slate-200/80 px-3 py-3">
        <div className="min-w-0 text-sm">
          <div className="frameos-strong truncate font-semibold text-slate-800">
            {activeScene ? sceneDisplayName(activeScene) : 'current image'}
          </div>
          {nextSchedule ? (
            <div className="frameos-muted mt-1 truncate text-xs text-slate-500">
              {`${scheduleDatePrefix(nextSchedule.date)} ${scheduleTimeLabel(nextSchedule.event)}: ${sceneDisplayName(
                scheduledScene,
                'Unknown scene'
              )}`}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function FrameHeaderActions({ frame, archived }: { frame: FrameType; archived?: boolean }): JSX.Element {
  const { openChatDrawer } = useActions(workspaceLogic)

  return (
    <div className="frame-header-actions flex min-w-0 shrink-0 items-center justify-start gap-1">
      <HeaderMetrics frameId={frame.id} />
      <div className="frame-header-action-buttons flex shrink-0 items-center gap-1">
        <button
          type="button"
          title="Open AI chat"
          onClick={() => openChatDrawer(frame.id, null)}
          className="frame-header-icon-button flex h-9 w-9 shrink-0 items-center justify-center rounded-lg !px-0 !py-0 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <SparklesIcon className="h-5 w-5" />
        </button>
        <FrameActionsMenu
          frame={frame}
          archived={archived}
          buttonColor="none"
          className="frame-header-icon-button flex h-9 w-9 shrink-0 items-center justify-center rounded-lg !px-0 !py-0 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        />
      </div>
    </div>
  )
}

function FrameDashboardHeader({ frame, archived }: { frame: FrameType; archived?: boolean }): JSX.Element {
  const healthy = frameIsHealthy(frame)
  const connected = (frame.active_connections ?? 0) > 0
  const inFrameAdminMode = isInFrameAdminMode()

  return (
    <div className="frame-dashboard-header mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="group flex min-w-[14rem] flex-1 items-center gap-3">
        {inFrameAdminMode ? (
          <FrameLocalDeployMenu
            frameId={frame.id}
            buttonTitle="Frame actions"
            buttonClassName="frameos-icon-tile flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/70 !px-0 !py-0 text-slate-700 shadow-sm transition"
            buttonContent={<DeployToFrameIcon className="h-7 w-7" />}
          />
        ) : (
          <FrameChangeStatusIcon frameId={frame.id} variant="dashboard" />
        )}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <A
              href={urls.frame(frame.id, 'overview')}
              className="min-w-0 rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <h2
                data-workspace-frame-title={frame.id}
                className="frameos-strong truncate text-2xl font-bold tracking-normal text-slate-950"
              >
                {frame.name || frameHost(frame)}
              </h2>
            </A>
            <FrameMetricAlertIndicator frame={frame} className="h-5 w-5" />
            {archived ? (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500">
                Archived
              </span>
            ) : null}
            {connected ? (
              <FrameConnectionDot
                title={healthy ? 'Frame is healthy and FrameOS Remote connected' : 'FrameOS Remote connected'}
              />
            ) : healthy ? (
              <span title="Frame is healthy" className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            ) : null}
          </div>
          <FrameDashboardStatusLine frame={frame} />
        </div>
      </div>
      <FrameHeaderActions frame={frame} archived={archived} />
    </div>
  )
}

function FrameDashboardStatusLine({ frame }: { frame: FrameType }): JSX.Element {
  const { undeployedChangeDetails, undeployedChanges, unsavedChanges } = useValues(frameLogic({ frameId: frame.id }))
  const { openFrameChangeDrawer } = useActions(workspaceLogic)
  const onlyFrameosUpgrade =
    !unsavedChanges &&
    undeployedChangeDetails.length > 0 &&
    undeployedChangeDetails.every((change) => change.frameosVersionChange || change.remoteVersionChange)
  const changeLabel = unsavedChanges
    ? 'unsaved'
    : onlyFrameosUpgrade
    ? 'upgrade'
    : undeployedChanges
    ? 'deploy now'
    : 'up to date'
  const frameIsUpToDate = !unsavedChanges && !undeployedChanges

  return (
    <div className="frameos-muted truncate text-sm text-slate-500">
      <button
        type="button"
        onClick={() => openFrameChangeDrawer(frame.id, unsavedChanges ? 'unsaved' : 'deploy')}
        className={clsx(
          'frameos-change-status-link rounded font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
          frameIsUpToDate ? 'frameos-change-status-link--up-to-date' : null
        )}
      >
        {changeLabel}
      </button>
      <span> - </span>
      {frameStatus(frame)}
    </div>
  )
}

function FrameSceneTile({
  frame,
  scene,
  scenes,
  active,
  highlighted,
  showMenu,
  childSceneCount,
  childrenExpanded,
  nested,
  onToggleChildren,
}: {
  frame: FrameType
  scene: FrameScene
  scenes: FrameScene[]
  active: boolean
  highlighted: boolean
  showMenu?: boolean
  childSceneCount?: number
  childrenExpanded?: boolean
  nested?: boolean
  onToggleChildren?: () => void
}): JSX.Element {
  const { openSceneControl } = useActions(workspaceLogic)
  const { hideForm } = useActions(newFrameForm)
  const compiled = sceneIsCompiled(scene, frame.mode)
  const hasChildScenes = (childSceneCount ?? 0) > 0

  const handleOpenSceneControl = (): void => {
    hideForm()
    openSceneControl(frame.id, scene.id)
  }

  const buttonContent = (
    <>
      <div className="frameos-card-media relative flex min-h-0 flex-1 items-center justify-center bg-slate-100">
        <FrameImage
          frameId={frame.id}
          sceneId={scene.id}
          thumb
          refreshable={false}
          objectFit="cover"
          className="h-full w-full rounded-none"
        />
      </div>
      <div className="w-full px-3 py-2">
        <div className="frameos-strong truncate text-sm font-semibold text-slate-900">
          {scene.name || 'Untitled scene'}
        </div>
        <div className="frameos-muted mt-0.5 truncate text-xs text-slate-500">{sceneTileSummaryLabel(scene)}</div>
      </div>
    </>
  )

  const tile = (
    <div
      draggable
      data-workspace-scene-tile={scene.id}
      data-workspace-scene-tile-frame={frame.id}
      onDragStart={(event) => setFrameosSceneDragData(event.dataTransfer, scene.id)}
      className={clsx(
        'frameos-card group relative z-[1] h-36 w-36 shrink-0 overflow-hidden rounded-lg border bg-white text-left transition hover:-translate-y-0.5 focus-within:ring-2 focus-within:ring-blue-400',
        nested && 'frameos-scene-child-tile',
        highlighted
          ? selectedSurfaceClassName
          : 'border-white/90 shadow-lg shadow-slate-300/35 hover:shadow-xl hover:shadow-slate-300/50'
      )}
    >
      <button type="button" onClick={handleOpenSceneControl} className="flex h-full w-full flex-col">
        {buttonContent}
      </button>
      {compiled || active ? (
        <div className="pointer-events-none absolute left-1 top-1 z-10 flex flex-col items-start gap-1">
          {compiled ? (
            <div className="pointer-events-auto">
              <CompiledSceneTag className="!bg-white/95 !border-slate-500/45 !px-1.5 !py-0 !text-[9px] !font-semibold !leading-4 !text-slate-700 shadow-sm backdrop-blur-sm" />
            </div>
          ) : null}
          {active ? (
            <div className="frameos-primary-fill rounded-full px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm">
              Active
            </div>
          ) : null}
        </div>
      ) : null}
      {hasChildScenes ? (
        <button
          type="button"
          aria-label={`${childrenExpanded ? 'Hide' : 'Show'} ${childSceneCount} nested ${
            childSceneCount === 1 ? 'scene' : 'scenes'
          }`}
          aria-expanded={childrenExpanded}
          onClick={(event) => {
            event.stopPropagation()
            onToggleChildren?.()
          }}
          className="frameos-scene-child-toggle absolute right-2 top-2 z-20 flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs font-bold shadow-sm backdrop-blur-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {childrenExpanded ? '-' : '+'}
          {childSceneCount}
        </button>
      ) : null}
      {showMenu ? (
        <WorkspaceSceneDropDown
          frame={frame}
          scene={scene}
          scenes={scenes}
          horizontal
          buttonColor="none"
          className={clsx(
            'absolute right-2 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-white/70 !px-0 !py-0 text-slate-500/80 shadow-sm backdrop-blur-sm transition hover:bg-white/95 hover:text-slate-700',
            hasChildScenes ? 'top-11' : 'top-2'
          )}
        />
      ) : null}
    </div>
  )

  if (!nested) {
    return tile
  }

  return (
    <div className="relative h-36 w-36 shrink-0">
      <SceneDependencyConnector />
      {tile}
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
      data-workspace-add-scene-tile={frame.id}
      data-workspace-add-scene-tile-frame={frame.id}
      onClick={() => {
        hideForm()
        closeSceneControl()
        openTemplateDrawer(frame.id)
      }}
      className={clsx(
        'frameos-primary-hover-text frameos-add-scene-hover frameos-card group flex shrink-0 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-white/55 text-center text-slate-500 shadow-sm transition hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        'frameos-add-scene-tile',
        active ? activeSurfaceClassName : 'border-slate-300 hover:shadow-lg hover:shadow-slate-300/35',
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

function BlankFrameSceneHint(): JSX.Element {
  return (
    <div className="frameos-blank-frame-scene-hint mb-4 rounded-lg border border-amber-200 bg-amber-100 px-4 py-3 text-sm font-medium leading-5 text-amber-950 shadow-sm">
      This frame has no scenes yet. Click <span className="font-bold">Add scene</span> to choose a template or create a
      scene, then save it. After adding scenes, deploy the changes to the frame so they appear on the display.
    </div>
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
  const { frameAssetFolderExpansion, sceneControlSelection, search } = useValues(workspaceLogic)
  const { openSceneControl, setFrameAssetFolderExpanded } = useActions(workspaceLogic)
  const { applyTemplateAndSave } = useActions(frameLogic({ frameId: frame.id }))
  const { applyRemoteToFrame } = useActions(templatesLogic({ frameId: frame.id }))
  const searchIsActive = search.trim().length > 0
  const allScenes = searchIsActive ? frame.scenes ?? scenes : scenes
  const { childrenBySceneId, sceneById } = buildSceneDependencyGraph(allScenes)
  const matchingSceneIds = searchIsActive ? new Set(scenes.map((scene) => scene.id)) : null
  const groupingEnabled = sceneDependencyGroupingIsEnabled(frameAssetFolderExpansion, frame.id, 'overview')
  const sceneOverviewEntries = groupingEnabled
    ? buildSceneDependencyEntries({
        childrenBySceneId,
        frameId: frame.id,
        matchingSceneIds,
        sceneById,
        sceneChildExpansion: frameAssetFolderExpansion,
        scenes: allScenes,
      })
    : flatSceneDependencyEntries(scenes)
  const visibleSceneToolButtons = isInFrameAdminMode()
    ? sceneToolButtons.filter(({ panel }) => !frameAdminUnsupportedSceneToolPanels.has(panel))
    : sceneToolButtons

  const handleScenesDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFrameosSceneListDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = getFrameosTemplateDragData(event.dataTransfer) ? 'copy' : 'move'
  }

  const handleScenesDrop = (event: DragEvent<HTMLDivElement>) => {
    const templateDragData = getFrameosTemplateDragData(event.dataTransfer)
    if (templateDragData) {
      event.preventDefault()
      event.stopPropagation()
      if (templateDragData.repository) {
        applyRemoteToFrame(templateDragData.repository, templateDragData.template, true)
      } else {
        applyTemplateAndSave(templateDragData.template)
      }
      return
    }

    const sceneId = getFrameosSceneDragData(event.dataTransfer)
    if (!sceneId || !frame.scenes?.some((scene) => scene.id === sceneId)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    openSceneControl(frame.id, sceneId)
  }

  return (
    <div className="min-w-0" onDragOver={handleScenesDragOver} onDrop={handleScenesDrop}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {visibleSceneToolButtons.map(({ label, panel, icon: Icon }) => (
          <A
            key={panel}
            href={urls.frame(frame.id, panel)}
            className="frameos-secondary-button inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/80 px-2.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <Icon className="h-4 w-4" />
            {label}
          </A>
        ))}
        <SceneDependencyFormatMenu frameId={frame.id} surface="overview" />
      </div>
      {sceneOverviewEntries.length > 0 ? (
        <div className="flex flex-wrap gap-4">
          {sceneOverviewEntries.map(({ scene, key, nested }) => {
            const active = sceneIsActive(scene, frame.active_scene_id)
            const selected =
              sceneControlSelection?.frameId === frame.id &&
              sceneControlSelection.sceneId === scene.id &&
              sceneControlSelection.source !== 'preview'
            const childSceneCount = groupingEnabled ? childrenBySceneId.get(scene.id)?.length ?? 0 : 0
            const childrenExpanded = !!frameAssetFolderExpansion[sceneChildExpansionKey(frame.id, scene.id)]
            return (
              <FrameSceneTile
                key={key}
                frame={frame}
                scene={scene}
                scenes={allScenes}
                active={active}
                highlighted={selected}
                showMenu={showSceneMenus}
                childSceneCount={childSceneCount}
                childrenExpanded={childrenExpanded}
                nested={nested}
                onToggleChildren={() =>
                  setFrameAssetFolderExpanded(frame.id, sceneChildExpansionPath(scene.id), !childrenExpanded)
                }
              />
            )
          })}
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
        <div>
          <BlankFrameSceneHint />
          <div className="flex flex-wrap gap-4">
            <FrameAddSceneTile frame={frame} compact />
          </div>
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
  const { applyTemplateAndSave } = useActions(frameLogic({ frameId: frame.id }))
  const { applyRemoteToFrame } = useActions(templatesLogic({ frameId: frame.id }))

  const handleFrameDragOver = (event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(FRAMEOS_TEMPLATE_DRAG_TYPE)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleFrameDrop = (event: DragEvent<HTMLElement>) => {
    const templateDragData = getFrameosTemplateDragData(event.dataTransfer)
    if (!templateDragData) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    if (templateDragData.repository) {
      applyRemoteToFrame(templateDragData.repository, templateDragData.template, true)
    } else {
      applyTemplateAndSave(templateDragData.template)
    }
  }

  return (
    <section
      id={sectionId}
      data-workspace-frame-section={frame.id}
      onDragOver={handleFrameDragOver}
      onDrop={handleFrameDrop}
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
