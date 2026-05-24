import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import {
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ComputerDesktopIcon,
  EyeIcon,
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
import { FrameImage } from '../../components/FrameImage'
import { frameHost, frameIsHealthy, frameIsStale, frameStatusDescription } from '../../decorators/frame'
import { urls } from '../../urls'
import { FrameScene, FrameType } from '../../types'
import { FrameosShell } from './FrameosShell'
import { workspaceLogic } from './workspaceLogic'
import type { OverviewFrameSection, WorkspaceUtilityPanel } from './workspaceLogic'
import { NewFrame } from '../frames/NewFrame'
import { newFrameForm } from '../frames/newFrameForm'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { controlLogic } from '../frame/panels/Scenes/controlLogic'
import { ExpandedScene } from '../frame/panels/Scenes/ExpandedScene'
import { EditTemplateModal } from '../frame/panels/Templates/EditTemplateModal'
import { Templates } from '../frame/panels/Templates/Templates'
import { FrameDashboardSurface, FrameScheduleDrawer } from './FrameDashboardSurface'
import { FrameLiveBadge } from './FrameLiveBadge'
import { framesHomeLogic } from './framesHomeLogic'

const uploadedScenePrefix = 'uploaded/'
const activeSurfaceClassName = 'border-[#4a4b8c] shadow-[0_0_3px_3px_rgba(128,0,255,0.5)]'

const frameSectionToolLinks = [
  { label: 'Overview', panel: 'overview' },
  { label: 'Logs', panel: 'logs' },
  { label: 'Metrics', panel: 'metrics' },
  { label: 'Settings', panel: 'settings' },
] as const satisfies readonly { label: string; panel: WorkspaceUtilityPanel }[]

function sceneIsActive(scene: FrameScene, currentSceneId: string | null | undefined): boolean {
  return currentSceneId === scene.id || currentSceneId === `${uploadedScenePrefix}${scene.id}`
}

function SidebarStatusDots({ frame }: { frame: FrameType }): JSX.Element {
  const stale = frameIsStale(frame)
  const ready = frame.status === 'ready' && !stale
  const connected = (frame.active_connections ?? 0) > 0
  const statusDescription = frameStatusDescription(frame)

  return (
    <span className="flex shrink-0 items-center gap-1">
      <span
        title={statusDescription}
        className={clsx('h-2.5 w-2.5 rounded-full', stale ? 'bg-amber-400' : ready ? 'bg-emerald-400' : 'bg-slate-300')}
      />
      {connected ? <span title={statusDescription} className="h-2.5 w-2.5 rounded-full bg-blue-400" /> : null}
    </span>
  )
}

function FrameTree(): JSX.Element {
  const { archivedFramesExpanded, inactiveFramesExpanded, framesLoading } = useValues(framesModel)
  const { toggleArchivedFramesExpanded, toggleInactiveFramesExpanded } = useActions(framesModel)
  const {
    homeActiveFramesList: activeFramesList,
    homeInactiveFramesList: inactiveFramesList,
    orderedArchivedFramesList: archivedFramesList,
    selectedFrameId,
  } = useValues(workspaceLogic)
  const { selectFrame } = useActions(workspaceLogic)

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
            onSelect={selectFrame}
          />
          <FrameTreeGroup
            title="Inactive"
            frames={inactiveFramesList}
            selectedFrameId={selectedFrameId}
            onSelect={selectFrame}
            expanded={inactiveFramesExpanded}
            onToggle={toggleInactiveFramesExpanded}
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
                <A
                  key={frame.id}
                  href={urls.frame(frame.id, 'overview')}
                  title={`Open ${frame.name || frameHost(frame)} overview`}
                  onClick={() => selectFrame(frame.id)}
                  className={clsx(
                    'frameos-frame-row frameos-frame-row-archived flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                    selectedFrameId === frame.id ? 'frameos-frame-row-selected' : 'text-slate-500 hover:bg-slate-100'
                  )}
                >
                  <ComputerDesktopIcon className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{frame.name || frameHost(frame)}</span>
                    <span className="block truncate text-xs text-slate-400">{frameStatusDescription(frame)}</span>
                  </span>
                  <SidebarStatusDots frame={frame} />
                </A>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
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
  expanded,
  onToggle,
}: {
  title: string
  frames: FrameType[]
  selectedFrameId: number | null
  onSelect: (frameId: number | null) => void
  expanded?: boolean
  onToggle?: () => void
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
          {frames.map((frame) => {
            const frameName = frame.name || frameHost(frame)
            return (
              <A
                key={frame.id}
                href={urls.frame(frame.id, 'overview')}
                title={`Open ${frameName} overview`}
                onClick={() => onSelect(frame.id)}
                className={clsx(
                  'frameos-frame-row flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                  selectedFrameId === frame.id ? 'frameos-frame-row-selected' : 'text-slate-700 hover:bg-slate-100'
                )}
              >
                <ComputerDesktopIcon className="h-5 w-5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium">{frameName}</span>
                  <span className="block truncate text-xs text-slate-400">{frameStatusDescription(frame)}</span>
                </span>
                <SidebarStatusDots frame={frame} />
              </A>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function SceneTile({ frame, scene, active }: { frame: FrameType; scene: FrameScene; active: boolean }): JSX.Element {
  const { openSceneControl } = useActions(workspaceLogic)
  const { hideForm } = useActions(newFrameForm)
  const fieldCount = scene.fields?.filter((field) => field.access === 'public').length ?? 0

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
          ? `${activeSurfaceClassName} hover:shadow-[0_0_4px_4px_rgba(128,0,255,0.55)]`
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
      onClick={() => {
        hideForm()
        closeSceneControl()
        openTemplateDrawer(frame.id)
      }}
      className={clsx(
        'frameos-primary-hover-text frameos-card group flex shrink-0 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed bg-white/55 text-center text-slate-500 shadow-sm transition hover:-translate-y-0.5 hover:bg-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
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
  const { closeTemplateDrawer, openChatDrawer } = useActions(workspaceLogic)

  return (
    <div className="mb-4 grid gap-3">
      <button
        type="button"
        onClick={() => {
          createBlankSceneAndSave(undefined, true)
          closeTemplateDrawer()
        }}
        className="frameos-card group flex items-center gap-3 rounded-2xl border border-white/90 bg-white/80 px-4 py-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-lg hover:shadow-slate-300/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
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
        className="frameos-card group flex items-center gap-3 rounded-2xl border border-white/90 bg-white/80 px-4 py-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-lg hover:shadow-slate-300/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
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
          ? `${activeSurfaceClassName} hover:shadow-[0_0_4px_4px_rgba(128,0,255,0.55)]`
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
              <div className="mb-4 overflow-hidden rounded-2xl bg-slate-100">
                <FrameImage frameId={frame.id} sceneId={scene.id} refreshable={false} className="max-h-52 w-full" />
              </div>
              <div className="mb-4 flex flex-wrap gap-2">
                <A
                  href={urls.scenes(frame.id, scene.id)}
                  className="frameos-primary-action flex flex-1 items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
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
      className="frameos-danger-button flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
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
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={hideForm}
          className="frameos-icon-button flex h-10 w-10 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <XMarkIcon className="h-6 w-6" />
        </button>
      </div>
      <NewFrame />
    </div>
  )
}

function FramesLoadingPlaceholder(): JSX.Element {
  return (
    <div className="space-y-8 pb-12">
      <div className="frameos-muted flex items-center gap-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        <span>Loading frames</span>
        <span className="frameos-skeleton-line h-5 w-10 animate-pulse rounded-full" />
      </div>
      {[0, 1, 2].map((index) => (
        <section
          key={index}
          className="frameos-card overflow-hidden rounded-[24px] border border-white/80 bg-white/55 p-5 shadow-lg shadow-slate-300/25"
        >
          <div className="mb-5 flex items-center gap-3">
            <div className="frameos-skeleton-media h-11 w-11 animate-pulse rounded-2xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="frameos-skeleton-line h-5 w-44 max-w-full animate-pulse rounded-full" />
              <div className="frameos-skeleton-line h-3 w-64 max-w-full animate-pulse rounded-full opacity-75" />
            </div>
            <div className="frameos-skeleton-line h-9 w-24 animate-pulse rounded-full opacity-80" />
          </div>
          <div className="flex gap-4 overflow-hidden">
            {[0, 1, 2, 3].map((tile) => (
              <div
                key={tile}
                className="frameos-skeleton-surface h-36 w-36 shrink-0 overflow-hidden rounded-2xl shadow-sm"
              >
                <div className="frameos-skeleton-media h-24 animate-pulse" />
                <div className="space-y-2 p-3">
                  <div className="frameos-skeleton-line h-3 animate-pulse rounded-full" />
                  <div className="frameos-skeleton-line h-3 w-2/3 animate-pulse rounded-full opacity-75" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function FramesHome(): JSX.Element {
  useMountedLogic(framesHomeLogic)

  const { overviewActiveFrameSections, overviewInactiveFrameSections, overviewArchivedFrameSections } =
    useValues(workspaceLogic)
  const { showForm } = useActions(newFrameForm)
  const { formVisible } = useValues(newFrameForm)
  const { closeSceneControl, closeScheduleDrawer, closeTemplateDrawer } = useActions(workspaceLogic)
  const { sceneControlSelection, scheduleDrawerFrameId, templateDrawerFrameId } = useValues(workspaceLogic)
  const { archivedFramesExpanded, inactiveFramesExpanded, frames, framesLoading } = useValues(framesModel)
  const { toggleArchivedFramesExpanded, toggleInactiveFramesExpanded } = useActions(framesModel)
  const hasFrameSections =
    overviewActiveFrameSections.length + overviewInactiveFrameSections.length + overviewArchivedFrameSections.length > 0
  const scheduleDrawerFrame = scheduleDrawerFrameId ? frames[scheduleDrawerFrameId] : null

  return (
    <FrameosShell
      mode="frames"
      title="Frames"
      tree={<FrameTree />}
      primaryActionLabel="Add frame"
      onPrimaryAction={() => {
        closeSceneControl()
        closeScheduleDrawer()
        closeTemplateDrawer()
        showForm()
      }}
      rightPanel={
        formVisible ? (
          <AddFramePanel />
        ) : templateDrawerFrameId ? (
          <TemplateDrawer />
        ) : scheduleDrawerFrame ? (
          <FrameScheduleDrawer frame={scheduleDrawerFrame} />
        ) : sceneControlSelection ? (
          <SceneControlPanel />
        ) : null
      }
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
              <div className="space-y-8 border-t border-slate-300/70 pt-8">
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
          <div className="flex h-[50vh] items-center justify-center rounded-[24px] border border-white/80 bg-white/55 text-slate-500 shadow-lg shadow-slate-300/25">
            <div className="text-center">
              <PhotoIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" />
              <div className="text-lg font-semibold text-slate-700">No frames found</div>
              <div className="text-sm text-slate-500">Add a frame or clear the search.</div>
            </div>
          </div>
        )}
      </div>
    </FrameosShell>
  )
}

export default FramesHome
