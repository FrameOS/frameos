import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import type { MouseEvent } from 'react'
import {
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PhotoIcon,
  PencilSquareIcon,
  PlusIcon,
  RocketLaunchIcon,
  SparklesIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'
import { framesModel } from '../../models/framesModel'
import { DropdownMenu } from '../../components/DropdownMenu'
import { FrameConnectionDot } from '../../components/FrameConnectionDot'
import { FrameImage } from '../../components/FrameImage'
import {
  formatFrameRelativeTime,
  frameHost,
  frameIsHealthy,
  frameIsStale,
  frameNeedsInitialDeploy,
  frameStatusDescription,
} from '../../decorators/frame'
import { urls } from '../../urls'
import { FrameScene, FrameType } from '../../types'
import { FrameosShell } from './FrameosShell'
import { isMobileWorkspaceViewport, workspaceLogic } from './workspaceLogic'
import type { OverviewFrameSection, WorkspaceUtilityPanel } from './workspaceLogic'
import { NewFrame } from '../frames/NewFrame'
import { newFrameForm } from '../frames/newFrameForm'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { CompiledSceneTag } from '../frame/panels/Scenes/CompiledSceneTag'
import { ExpandedScene } from '../frame/panels/Scenes/ExpandedScene'
import { EditTemplateModal } from '../frame/panels/Templates/EditTemplateModal'
import { Templates } from '../frame/panels/Templates/Templates'
import { FrameDashboardSurface } from './FrameDashboardSurface'
import { FrameDashboardLoadingSkeleton } from './FrameDashboardLoadingSkeleton'
import { FrameLiveBadge } from './FrameLiveBadge'
import { framesHomeLogic } from './framesHomeLogic'
import { FrameChangeStatusIcon } from './FrameChangeStatusIcon'
import { sceneTileSummaryLabel } from './sceneTileLabels'

const uploadedScenePrefix = 'uploaded/'
const activeSurfaceClassName = 'frameos-active-surface'

const frameSectionToolLinks = [
  { label: 'Overview', panel: 'overview' },
  { label: 'Logs', panel: 'logs' },
  { label: 'Metrics', panel: 'metrics' },
  { label: 'Settings', panel: 'settings' },
] as const satisfies readonly { label: string; panel: WorkspaceUtilityPanel }[]

function sceneIsActive(scene: FrameScene, currentSceneId: string | null | undefined): boolean {
  return currentSceneId === scene.id || currentSceneId === `${uploadedScenePrefix}${scene.id}`
}

function SidebarStatusDots({ frame, inactive }: { frame: FrameType; inactive?: boolean }): JSX.Element {
  const stale = frameIsStale(frame)
  const ready = frame.status === 'ready' && !stale
  const connected = (frame.active_connections ?? 0) > 0
  const statusDescription = frameStatusDescription(frame)

  if (connected) {
    return <FrameConnectionDot title={statusDescription} />
  }

  return (
    <span
      title={statusDescription}
      className={clsx(
        'h-2.5 w-2.5 shrink-0 rounded-full',
        inactive
          ? 'bg-white shadow-sm ring-1 ring-slate-300/80'
          : stale
          ? 'bg-amber-400'
          : ready
          ? 'bg-emerald-400'
          : 'bg-slate-300'
      )}
    />
  )
}

function sidebarFrameActivityDescription(frame: FrameType): string {
  if (frameNeedsInitialDeploy(frame)) {
    return 'waiting for first deploy'
  }

  const relativeTime = formatFrameRelativeTime(frame.last_log_at)
  if (!relativeTime) {
    return 'no logs yet'
  }
  return `last seen ${relativeTime}`
}

function FrameTree(): JSX.Element {
  const { archivedFramesExpanded, inactiveFramesExpanded, framesLoading } = useValues(framesModel)
  const { toggleArchivedFramesExpanded, toggleInactiveFramesExpanded } = useActions(framesModel)
  const {
    frameChangeDrawerSelection,
    homeActiveFramesList: activeFramesList,
    homeInactiveFramesList: inactiveFramesList,
    orderedArchivedFramesList: archivedFramesList,
    selectedFrameId,
  } = useValues(workspaceLogic)
  const { closeSecondarySidebar, focusFrame, openFrameChangeDrawer, openFrameTool, selectFrame } =
    useActions(workspaceLogic)

  const focusFrameAfterDrawerUpdate = (frameId: number): void => {
    focusFrame(frameId)
    if (typeof window === 'undefined') {
      return
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => focusFrame(frameId))
      })
    })
  }

  const handleFrameClick = (event: MouseEvent<HTMLButtonElement>, frameId: number): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }

    event.preventDefault()
    selectFrame(frameId)
    if (isMobileWorkspaceViewport()) {
      closeSecondarySidebar()
    }
    if (frameChangeDrawerSelection?.kind === 'deploy' && frameChangeDrawerSelection.frameId !== frameId) {
      openFrameChangeDrawer(frameId, 'deploy')
      focusFrameAfterDrawerUpdate(frameId)
    } else {
      focusFrame(frameId)
    }
  }

  const handleFrameDoubleClick = (event: MouseEvent<HTMLButtonElement>, frameId: number): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }

    event.preventDefault()
    if (isMobileWorkspaceViewport()) {
      closeSecondarySidebar()
    }
    openFrameTool(frameId, 'overview')
  }

  return (
    <div className="space-y-5">
      {framesLoading && activeFramesList.length + inactiveFramesList.length + archivedFramesList.length === 0 ? (
        <FrameTreeLoadingPlaceholder />
      ) : (
        <>
          <FrameTreeGroup
            title="Active"
            frames={activeFramesList}
            selectedFrameId={selectedFrameId}
            onSelect={handleFrameClick}
            onOpen={handleFrameDoubleClick}
          />
          <FrameTreeGroup
            title="Inactive"
            frames={inactiveFramesList}
            selectedFrameId={selectedFrameId}
            onSelect={handleFrameClick}
            onOpen={handleFrameDoubleClick}
            expanded={inactiveFramesExpanded}
            onToggle={toggleInactiveFramesExpanded}
            inactive
          />
        </>
      )}
      {archivedFramesList.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={toggleArchivedFramesExpanded}
            aria-expanded={archivedFramesExpanded}
            className="frameos-icon-button mb-2 flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {archivedFramesExpanded ? (
              <ChevronDownIcon className="h-4 w-4" />
            ) : (
              <ChevronRightIcon className="h-4 w-4" />
            )}
            <ArchiveBoxIcon className="h-4 w-4" />
            <span className="flex-1">Archived</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
              {archivedFramesList.length}
            </span>
          </button>
          {archivedFramesExpanded ? (
            <div className="space-y-1">
              {archivedFramesList.map((frame) => (
                <FrameTreeRow
                  key={frame.id}
                  frame={frame}
                  selected={selectedFrameId === frame.id}
                  archived
                  onSelect={handleFrameClick}
                  onOpen={handleFrameDoubleClick}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function FrameTreeRow({
  frame,
  selected,
  archived = false,
  inactive = false,
  onSelect,
  onOpen,
}: {
  frame: FrameType
  selected: boolean
  archived?: boolean
  inactive?: boolean
  onSelect: (event: MouseEvent<HTMLButtonElement>, frameId: number) => void
  onOpen: (event: MouseEvent<HTMLButtonElement>, frameId: number) => void
}): JSX.Element {
  const frameName = frame.name || frameHost(frame)

  return (
    <div
      className={clsx(
        'frameos-frame-row flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left transition',
        archived && 'frameos-frame-row-archived',
        selected
          ? 'frameos-frame-row-selected'
          : archived
          ? 'text-slate-500 hover:bg-slate-100'
          : 'text-slate-700 hover:bg-slate-100'
      )}
    >
      <FrameChangeStatusIcon frameId={frame.id} />
      <button
        type="button"
        title={`Scroll to ${frameName}. Double-click to open overview.`}
        onClick={(event: MouseEvent<HTMLButtonElement>) => onSelect(event, frame.id)}
        onDoubleClick={(event: MouseEvent<HTMLButtonElement>) => onOpen(event, frame.id)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <span className="min-w-0 flex-1">
          <span className={clsx('block truncate', !archived && 'text-base font-medium')}>{frameName}</span>
          <span className="block truncate text-xs text-slate-400">{sidebarFrameActivityDescription(frame)}</span>
        </span>
        <SidebarStatusDots frame={frame} inactive={inactive} />
      </button>
    </div>
  )
}

function FrameTreeLoadingPlaceholder(): JSX.Element {
  return (
    <div>
      <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Loading</div>
      <div className="space-y-1.5">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex w-full items-center gap-1.5">
            <div className="frameos-skeleton-surface flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5">
              <div className="frameos-skeleton-media h-5 w-5 shrink-0 animate-pulse rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="frameos-skeleton-line h-3 w-28 max-w-full animate-pulse rounded-full" />
                <div className="frameos-skeleton-line h-2 w-20 max-w-full animate-pulse rounded-full opacity-70" />
              </div>
              <div className="frameos-skeleton-line h-2.5 w-7 shrink-0 animate-pulse rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FrameTreeGroup({
  title,
  frames,
  selectedFrameId,
  onSelect,
  onOpen,
  expanded,
  onToggle,
  inactive,
}: {
  title: string
  frames: FrameType[]
  selectedFrameId: number | null
  onSelect: (event: MouseEvent<HTMLButtonElement>, frameId: number) => void
  onOpen: (event: MouseEvent<HTMLButtonElement>, frameId: number) => void
  expanded?: boolean
  onToggle?: () => void
  inactive?: boolean
}): JSX.Element | null {
  if (frames.length === 0) {
    return null
  }

  const isExpanded = expanded ?? true

  return (
    <div>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          className="frameos-icon-button mb-2 flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {isExpanded ? <ChevronDownIcon className="h-4 w-4" /> : <ChevronRightIcon className="h-4 w-4" />}
          <span className="flex-1">{title}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
            {frames.length}
          </span>
        </button>
      ) : (
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {title} ({frames.length})
        </div>
      )}
      {isExpanded ? (
        <div className="space-y-1">
          {frames.map((frame) => (
            <FrameTreeRow
              key={frame.id}
              frame={frame}
              selected={selectedFrameId === frame.id}
              inactive={inactive}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SceneTile({ frame, scene, active }: { frame: FrameType; scene: FrameScene; active: boolean }): JSX.Element {
  const { openSceneControl } = useActions(workspaceLogic)
  const { hideForm } = useActions(newFrameForm)

  return (
    <button
      type="button"
      data-workspace-scene-tile={scene.id}
      data-workspace-scene-tile-frame={frame.id}
      onClick={() => {
        hideForm()
        openSceneControl(frame.id, scene.id)
      }}
      className={clsx(
        'frameos-card group flex min-h-36 w-full max-w-40 min-w-0 flex-col overflow-hidden rounded-2xl border bg-white text-left transition hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active
          ? activeSurfaceClassName
          : 'border-white/90 shadow-lg shadow-slate-300/35 hover:shadow-xl hover:shadow-slate-300/50'
      )}
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
      </div>
      <div className="w-full px-3 py-2">
        <div className="frameos-strong truncate text-sm font-semibold text-slate-900">
          {scene.name || 'Untitled scene'}
        </div>
        <div className="frameos-muted mt-0.5 truncate text-xs text-slate-500">{sceneTileSummaryLabel(scene)}</div>
      </div>
    </button>
  )
}

export function AddSceneTile({ frame, compact = false }: { frame: FrameType; compact?: boolean }): JSX.Element {
  const { hideForm } = useActions(newFrameForm)
  const { closeSceneControl, openTemplateDrawer } = useActions(workspaceLogic)
  const { templateDrawerFrameId } = useValues(workspaceLogic)
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
        'frameos-primary-hover-text frameos-add-scene-hover frameos-card group flex shrink-0 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed bg-white/55 text-center text-slate-500 shadow-sm transition hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
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

export function TemplateDrawer(): JSX.Element | null {
  const { templateDrawerFrameId } = useValues(workspaceLogic)
  const { frames } = useValues(framesModel)
  const { closeTemplateDrawer } = useActions(workspaceLogic)

  if (!templateDrawerFrameId) {
    return null
  }

  const frame = frames[templateDrawerFrameId]
  if (!frame) {
    return null
  }

  const frameLogicProps = { frameId: frame.id }

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 w-[430px] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <BindLogic logic={frameLogic} props={frameLogicProps}>
        <BindLogic logic={panelsLogic} props={frameLogicProps}>
          <div className="flex h-full flex-col">
            <div className="frameos-divider flex items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
              <div className="min-w-0">
                <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {frame.name || frameHost(frame)}
                </div>
                <h2 className="frameos-strong truncate text-xl font-bold tracking-normal text-slate-950">Add scene</h2>
              </div>
              <button
                type="button"
                onClick={closeTemplateDrawer}
                className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <AddSceneDrawerActions frame={frame} />
              <Templates persistOnInstall />
            </div>
            <EditTemplateModal />
          </div>
        </BindLogic>
      </BindLogic>
    </div>
  )
}

function AddSceneDrawerActions({ frame }: { frame: FrameType }): JSX.Element {
  const { createBlankSceneAndSave } = useActions(frameLogic({ frameId: frame.id }))
  const { openChatDrawer } = useActions(workspaceLogic)

  return (
    <div className="mb-4 grid gap-3">
      <button
        type="button"
        onClick={() => {
          createBlankSceneAndSave()
        }}
        className="frameos-template-action-button frameos-card group flex items-center gap-3 rounded-2xl border border-white/90 bg-white/80 px-4 py-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-lg hover:shadow-slate-300/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <span className="frameos-primary-hover-bg frameos-primary-hover-text frameos-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition">
          <PlusIcon className="h-6 w-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="frameos-strong block truncate text-sm font-semibold text-slate-900">New blank scene</span>
          <span className="frameos-muted block truncate text-xs text-slate-500">Start with a render event</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => {
          openChatDrawer(frame.id, null)
        }}
        className="frameos-template-action-button frameos-card group flex items-center gap-3 rounded-2xl border border-white/90 bg-white/80 px-4 py-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-lg hover:shadow-slate-300/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <span className="frameos-primary-hover-bg frameos-primary-hover-text frameos-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition">
          <SparklesIcon className="h-6 w-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="frameos-strong block truncate text-sm font-semibold text-slate-900">Generate scene</span>
          <span className="frameos-muted block truncate text-xs text-slate-500">Open AI chat for this frame</span>
        </span>
      </button>
    </div>
  )
}

function CurrentSnapshotCard({ frame, active }: { frame: FrameType; active: boolean }): JSX.Element {
  const { openFrameTool } = useActions(workspaceLogic)
  const { hideForm } = useActions(newFrameForm)

  return (
    <button
      type="button"
      onClick={() => {
        hideForm()
        openFrameTool(frame.id, 'preview')
      }}
      className={clsx(
        'frameos-card group flex w-80 max-w-full shrink-0 flex-col overflow-hidden rounded-[22px] border bg-white text-left transition hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        active
          ? activeSurfaceClassName
          : 'border-white/90 shadow-xl shadow-slate-300/35 hover:shadow-2xl hover:shadow-slate-300/45'
      )}
    >
      <div className="frameos-card-media relative flex h-[24rem] max-h-[75vh] min-h-0 items-center justify-center overflow-hidden bg-slate-100">
        <FrameImage frameId={frame.id} refreshable={false} objectFit="contain" className="h-full w-full rounded-none" />
        <FrameLiveBadge frame={frame} className="right-3 top-3" />
      </div>
      <div className="px-4 py-3">
        <div className="frameos-muted text-xs text-slate-500">
          Last rendered image from {frame.name || frameHost(frame)}
        </div>
      </div>
    </button>
  )
}

function FrameSectionToolLinks({ frame }: { frame: FrameType }): JSX.Element {
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center justify-start gap-1.5 @4xl:justify-end">
      {frameSectionToolLinks.map(({ label, panel }) => (
        <A
          key={panel}
          href={urls.frame(frame.id, panel)}
          className="frameos-secondary-button rounded-lg bg-white/80 px-3 py-1.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {label}
        </A>
      ))}
    </div>
  )
}

function FrameSection({ section }: { section: OverviewFrameSection }): JSX.Element {
  const { frame, scenes, archived, frameMatchesSearch } = section

  return (
    <FrameDashboardSurface
      frame={frame}
      scenes={scenes}
      totalScenes={frame.scenes?.length ?? scenes.length}
      archived={archived}
      frameMatchesSearch={frameMatchesSearch}
      sectionId={`workspace-frame-${frame.id}`}
    />
  )
}

function FrameSectionGroup({
  title,
  sections,
  expanded,
  onToggle,
}: {
  title: string
  sections: OverviewFrameSection[]
  expanded?: boolean
  onToggle?: () => void
}): JSX.Element | null {
  if (sections.length === 0) {
    return null
  }

  const isExpanded = expanded ?? true

  return (
    <div className="space-y-8">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          className="frameos-icon-button frameos-muted flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm font-semibold uppercase tracking-wide text-slate-500 transition hover:bg-white/55 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {isExpanded ? <ChevronDownIcon className="h-5 w-5" /> : <ChevronRightIcon className="h-5 w-5" />}
          <span className="flex-1">{title}</span>
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500">
            {sections.length}
          </span>
        </button>
      ) : (
        <div className="frameos-muted flex items-center gap-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <span>{title}</span>
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500">
            {sections.length}
          </span>
        </div>
      )}
      {isExpanded ? sections.map((section) => <FrameSection key={section.frame.id} section={section} />) : null}
    </div>
  )
}

export function SceneControlPanel(): JSX.Element | null {
  const { sceneControlSelection } = useValues(workspaceLogic)
  const { frames } = useValues(framesModel)
  const { closeSceneControl } = useActions(workspaceLogic)

  if (!sceneControlSelection) {
    return null
  }

  const frame = frames[sceneControlSelection.frameId]
  const scene = frame?.scenes?.find((candidate) => candidate.id === sceneControlSelection.sceneId)

  if (!frame || !scene) {
    return null
  }

  const frameLogicProps = { frameId: frame.id }
  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 w-[390px] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <BindLogic logic={frameLogic} props={frameLogicProps}>
        <BindLogic logic={panelsLogic} props={frameLogicProps}>
          <div className="flex h-full flex-col">
            <div className="frameos-divider flex items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
              <div className="min-w-0">
                <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {frame.name || frameHost(frame)}
                </div>
                <h2 className="frameos-strong truncate text-xl font-bold tracking-normal text-slate-950">
                  {scene.name}
                </h2>
              </div>
              <button
                type="button"
                onClick={closeSceneControl}
                className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div
                className="frameos-card-media frameos-skeleton-surface relative mb-4 flex w-full items-center justify-center overflow-hidden rounded-lg bg-slate-100"
                style={{ aspectRatio: '16 / 9' }}
              >
                <FrameImage
                  frameId={frame.id}
                  sceneId={scene.id}
                  thumb
                  refreshable={false}
                  objectFit="contain"
                  hideWhileLoading
                  loadFullSizeAfterThumb
                  className="h-full w-full"
                  imageClassName="h-full w-full rounded-md object-contain"
                />
                {scene.settings?.execution !== 'interpreted' ? (
                  <div className="absolute left-2 top-2 z-10">
                    <CompiledSceneTag className="!bg-white/95 !border-slate-500/45 !text-slate-700 shadow-sm backdrop-blur-sm" />
                  </div>
                ) : null}
              </div>
              <div className="mb-4 flex flex-wrap gap-2">
                <A
                  href={urls.scenes(frame.id, scene.id)}
                  className="frameos-secondary-button flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  <PencilSquareIcon className="h-5 w-5" />
                  Open editor
                </A>
                <DeleteInstalledSceneButton frame={frame} scene={scene} />
              </div>
              <SceneControlPanelModeTitle />
              <ExpandedScene frameId={frame.id} sceneId={scene.id} scene={scene} showEditButton={false} />
            </div>
          </div>
        </BindLogic>
      </BindLogic>
    </div>
  )
}

function SceneControlPanelModeTitle(): JSX.Element {
  return (
    <div className="frameos-divider mb-4 border-t border-slate-200/80 pt-4">
      <div className="frameos-muted text-xs font-semibold uppercase tracking-wide">Scene control</div>
    </div>
  )
}

function DeleteInstalledSceneButton({ frame, scene }: { frame: FrameType; scene: FrameScene }): JSX.Element {
  const { deleteSceneAndSave } = useActions(frameLogic({ frameId: frame.id }))
  const { closeSceneControl } = useActions(workspaceLogic)

  return (
    <button
      type="button"
      onClick={() => {
        if (!window.confirm(`Delete "${scene.name || 'Untitled scene'}" from ${frame.name || frameHost(frame)}?`)) {
          return
        }
        deleteSceneAndSave(scene.id)
        closeSceneControl()
      }}
      className="frameos-secondary-button flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      title="Delete scene"
    >
      <TrashIcon className="h-5 w-5" />
      Delete
    </button>
  )
}

function AddFramePanel(): JSX.Element | null {
  const { formVisible } = useValues(newFrameForm)
  const { hideForm } = useActions(newFrameForm)

  if (!formVisible) {
    return null
  }

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 w-[390px] overflow-y-auto rounded-[24px] border border-white/80 bg-white/95 p-5 text-slate-900 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <NewFrame
        headerAction={
          <button
            type="button"
            onClick={hideForm}
            className="frameos-icon-button flex h-10 w-10 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        }
      />
    </div>
  )
}

function FramesLoadingPlaceholder(): JSX.Element {
  return <FrameDashboardLoadingSkeleton />
}

export function FramesHome(): JSX.Element {
  useMountedLogic(framesHomeLogic)

  const { overviewActiveFrameSections, overviewInactiveFrameSections, overviewArchivedFrameSections } =
    useValues(workspaceLogic)
  const { showForm } = useActions(newFrameForm)
  const { formVisible } = useValues(newFrameForm)
  const { closeSceneControl, closeTemplateDrawer } = useActions(workspaceLogic)
  const { sceneControlSelection, templateDrawerFrameId } = useValues(workspaceLogic)
  const { archivedFramesExpanded, inactiveFramesExpanded, framesLoading } = useValues(framesModel)
  const { toggleArchivedFramesExpanded, toggleInactiveFramesExpanded } = useActions(framesModel)
  const hasFrameSections =
    overviewActiveFrameSections.length + overviewInactiveFrameSections.length + overviewArchivedFrameSections.length > 0

  return (
    <FrameosShell
      mode="frames"
      title="Frames"
      browserTitle={null}
      tree={<FrameTree />}
      primaryActionLabel="Add frame"
      onPrimaryAction={() => {
        closeSceneControl()
        closeTemplateDrawer()
        showForm()
      }}
      rightPanel={
        formVisible ? (
          <AddFramePanel />
        ) : templateDrawerFrameId ? (
          <TemplateDrawer />
        ) : sceneControlSelection ? (
          <SceneControlPanel />
        ) : null
      }
      rightPanelSize={formVisible ? 'compact' : 'normal'}
    >
      <div className="space-y-12 pb-12">
        {hasFrameSections ? (
          <>
            <FrameSectionGroup title="Active" sections={overviewActiveFrameSections} />
            <FrameSectionGroup
              title="Inactive"
              sections={overviewInactiveFrameSections}
              expanded={inactiveFramesExpanded}
              onToggle={toggleInactiveFramesExpanded}
            />
            {overviewArchivedFrameSections.length > 0 ? (
              <div className="space-y-8 pt-2">
                <button
                  type="button"
                  onClick={toggleArchivedFramesExpanded}
                  aria-expanded={archivedFramesExpanded}
                  className="frameos-icon-button frameos-muted flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm font-semibold uppercase tracking-wide text-slate-500 transition hover:bg-white/55 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  {archivedFramesExpanded ? (
                    <ChevronDownIcon className="h-5 w-5" />
                  ) : (
                    <ChevronRightIcon className="h-5 w-5" />
                  )}
                  <ArchiveBoxIcon className="h-5 w-5" />
                  <span className="flex-1">Archived</span>
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500">
                    {overviewArchivedFrameSections.length}
                  </span>
                </button>
                {archivedFramesExpanded
                  ? overviewArchivedFrameSections.map((section) => (
                      <FrameSection key={section.frame.id} section={section} />
                    ))
                  : null}
              </div>
            ) : null}
          </>
        ) : framesLoading ? (
          <FramesLoadingPlaceholder />
        ) : (
          <div className="frameos-muted flex h-[50vh] items-center justify-center">
            <div className="text-center">
              <PhotoIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" />
              <div className="text-base font-semibold">No frames found</div>
              <div className="mt-1 text-sm">Add a frame or clear the search.</div>
            </div>
          </div>
        )}
      </div>
    </FrameosShell>
  )
}

export default FramesHome
