import { useActions, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import type { CSSProperties, DragEvent, FormEvent } from 'react'
import {
  AdjustmentsHorizontalIcon,
  ArchiveBoxIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  CircleStackIcon,
  CommandLineIcon,
  DocumentTextIcon,
  PencilSquareIcon,
  PlusIcon,
  PowerIcon,
  RocketLaunchIcon,
  SignalIcon,
  StopCircleIcon,
  SparklesIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'

import { DropdownMenu } from '../../components/DropdownMenu'
import { FrameConnectionDot } from '../../components/FrameConnectionDot'
import { FrameImage } from '../../components/FrameImage'
import { Modal } from '../../components/Modal'
import { TextInput } from '../../components/TextInput'
import { frameHost, frameIsHealthy, frameStatus } from '../../decorators/frame'
import { framesModel } from '../../models/framesModel'
import { urls } from '../../urls'
import type { FrameScene, FrameType, ScheduledEvent } from '../../types'
import { frameLogic } from '../frame/frameLogic'
import { HeaderMetrics } from '../frame/panels/Metrics/HeaderMetrics'
import { CompiledSceneTag } from '../frame/panels/Scenes/CompiledSceneTag'
import { templatesLogic } from '../frame/panels/Templates/templatesLogic'
import { newFrameForm } from '../frames/newFrameForm'
import { FrameLiveBadge } from './FrameLiveBadge'
import { FrameChangeStatusIcon } from './FrameChangeStatusIcon'
import { WorkspaceSceneDropDown } from './WorkspaceSceneDropDown'
import {
  FRAMEOS_TEMPLATE_DRAG_TYPE,
  getFrameosSceneDragData,
  getFrameosTemplateDragData,
  hasFrameosSceneListDragData,
  setFrameosSceneDragData,
} from './sceneDrag'
import { sceneTileSummaryLabel } from './sceneTileLabels'
import { workspaceLogic } from './workspaceLogic'

const uploadedScenePrefix = 'uploaded/'
const activeSurfaceClassName = 'frameos-active-surface'
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

function sceneIsCompiled(scene: FrameScene): boolean {
  return scene.settings?.execution !== 'interpreted'
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
  const activeScene = scenes.find((scene) => sceneIsActive(scene, frame.active_scene_id))
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
  const {
    deleteFrame,
    deployAgent,
    rebootFrame,
    renderFrame,
    restartAgent,
    restartFrame,
    setFrameArchived,
    stopFrame,
  } = useActions(framesModel)
  const { openChatDrawer, openFrameChangeDrawer, openRenameFrameDialog } = useActions(workspaceLogic)
  const frameName = frame.name || frameHost(frame)
  const agentConfigured = Boolean(frame.agent?.agentEnabled && frame.agent.agentSharedSecret)
  const canDeployAgent = agentConfigured && (frame.mode ?? 'rpios') === 'rpios'

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
        <DropdownMenu
          buttonColor="none"
          horizontal
          className="frame-header-icon-button flex h-9 w-9 shrink-0 items-center justify-center rounded-lg !px-0 !py-0 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          items={[
            {
              label: 'Rename',
              title: 'Rename frame',
              onClick: () => openRenameFrameDialog(frame.id, frameName),
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
              title: 'Open deploy options',
              onClick: () => openFrameChangeDrawer(frame.id, 'deploy'),
              icon: <RocketLaunchIcon className="h-5 w-5" />,
            },
            {
              label: 'Stop FrameOS',
              title: 'Stop FrameOS service',
              onClick: () => stopFrame(frame.id),
              icon: <StopCircleIcon className="h-5 w-5" />,
            },
            {
              label: 'Restart FrameOS',
              title: 'Restart FrameOS service',
              onClick: () => restartFrame(frame.id),
              icon: <ArrowPathIcon className="h-5 w-5" />,
            },
            {
              label: 'Reboot device',
              title: 'Reboot device',
              onClick: () => rebootFrame(frame.id),
              icon: <PowerIcon className="h-5 w-5" />,
            },
            ...(agentConfigured
              ? [
                  {
                    label: 'Restart agent',
                    title: 'Restart FrameOS agent',
                    onClick: () => restartAgent(frame.id),
                    icon: <CommandLineIcon className="h-5 w-5" />,
                  },
                ]
              : []),
            ...(canDeployAgent
              ? [
                  {
                    label: 'Deploy agent',
                    title: 'Deploy FrameOS agent',
                    onClick: () => deployAgent(frame.id),
                    icon: <CommandLineIcon className="h-5 w-5" />,
                  },
                ]
              : []),
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
    </div>
  )
}

function FrameDashboardHeader({ frame, archived }: { frame: FrameType; archived?: boolean }): JSX.Element {
  const healthy = frameIsHealthy(frame)
  const connected = (frame.active_connections ?? 0) > 0

  return (
    <div className="frame-dashboard-header mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="group flex min-w-[14rem] flex-1 items-center gap-3">
        <FrameChangeStatusIcon frameId={frame.id} variant="dashboard" />
        <div className="min-w-0">
          <A
            href={urls.frame(frame.id, 'overview')}
            className="rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
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
              {connected ? (
                <FrameConnectionDot
                  title={healthy ? 'Frame is healthy and agent connected' : 'FrameOS agent connected'}
                />
              ) : healthy ? (
                <span title="Frame is healthy" className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
              ) : null}
            </div>
          </A>
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
    undeployedChangeDetails.every((change) => change.label.startsWith('FrameOS upgrade'))
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

function RenameFrameModal({ frame }: { frame: FrameType }): JSX.Element | null {
  const { renameFrameDialog } = useValues(workspaceLogic)
  const { closeRenameFrameDialog, setRenameFrameName } = useActions(workspaceLogic)
  const { renameFrame } = useActions(framesModel)

  if (!renameFrameDialog || renameFrameDialog.frameId !== frame.id) {
    return null
  }

  const frameName = frame.name || frameHost(frame)
  const nextName = renameFrameDialog.name.trim()
  const canSave = nextName.length > 0 && nextName !== frameName

  const submitRename = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!canSave) {
      return
    }
    renameFrame(frame.id, nextName)
    closeRenameFrameDialog()
  }

  return (
    <Modal open onClose={closeRenameFrameDialog} title="Rename frame">
      <form onSubmit={submitRename} className="space-y-4 p-5">
        <label className="block">
          <span className="frameos-muted mb-2 block text-sm font-semibold">Frame name</span>
          <TextInput autoFocus value={renameFrameDialog.name} onChange={setRenameFrameName} />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeRenameFrameDialog}
            className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Rename
          </button>
        </div>
      </form>
    </Modal>
  )
}

function FrameSceneTile({
  frame,
  scene,
  scenes,
  active,
  highlighted,
  showMenu,
}: {
  frame: FrameType
  scene: FrameScene
  scenes: FrameScene[]
  active: boolean
  highlighted: boolean
  showMenu?: boolean
}): JSX.Element {
  const { openSceneControl } = useActions(workspaceLogic)
  const { hideForm } = useActions(newFrameForm)
  const compiled = sceneIsCompiled(scene)

  return (
    <div
      draggable
      data-workspace-scene-tile={scene.id}
      data-workspace-scene-tile-frame={frame.id}
      onDragStart={(event) => setFrameosSceneDragData(event.dataTransfer, scene.id)}
      className={clsx(
        'frameos-card group relative h-36 w-36 shrink-0 overflow-hidden rounded-lg border bg-white text-left transition hover:-translate-y-0.5 focus-within:ring-2 focus-within:ring-blue-400',
        highlighted
          ? activeSurfaceClassName
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
        </div>
        <div className="w-full px-3 py-2">
          <div className="frameos-strong truncate text-sm font-semibold text-slate-900">
            {scene.name || 'Untitled scene'}
          </div>
          <div className="frameos-muted mt-0.5 truncate text-xs text-slate-500">{sceneTileSummaryLabel(scene)}</div>
        </div>
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
      {showMenu ? (
        <WorkspaceSceneDropDown
          frame={frame}
          scene={scene}
          scenes={scenes}
          horizontal
          buttonColor="none"
          className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-white/70 !px-0 !py-0 text-slate-500/80 shadow-sm backdrop-blur-sm transition hover:bg-white/95 hover:text-slate-700"
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
  const { sceneControlSelection, search } = useValues(workspaceLogic)
  const { openSceneControl } = useActions(workspaceLogic)
  const { applyTemplateAndSave } = useActions(frameLogic({ frameId: frame.id }))
  const { applyRemoteToFrame } = useActions(templatesLogic({ frameId: frame.id }))

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
          {scenes.map((scene) => {
            const active = sceneIsActive(scene, frame.active_scene_id)
            const selected = sceneControlSelection?.frameId === frame.id && sceneControlSelection.sceneId === scene.id
            return (
              <FrameSceneTile
                key={scene.id}
                frame={frame}
                scene={scene}
                scenes={scenes}
                active={active}
                highlighted={active || selected}
                showMenu={showSceneMenus}
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
      <RenameFrameModal frame={frame} />
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
