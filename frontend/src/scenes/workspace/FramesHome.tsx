import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import {
  ArchiveBoxIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ComputerDesktopIcon,
  PhotoIcon,
  PlusIcon,
  SparklesIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'
import { framesModel } from '../../models/framesModel'
import { FrameImage } from '../../components/FrameImage'
import { frameHost, frameIsHealthy, frameIsStale, frameStatus } from '../../decorators/frame'
import { urls } from '../../urls'
import { FrameScene, FrameType } from '../../types'
import { HomeyShell } from './HomeyShell'
import { OverviewFrameSection, workspaceLogic } from './workspaceLogic'
import { NewFrame } from '../frames/NewFrame'
import { newFrameForm } from '../frames/newFrameForm'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { ExpandedScene } from '../frame/panels/Scenes/ExpandedScene'
import { EditTemplateModal } from '../frame/panels/Templates/EditTemplateModal'
import { Templates } from '../frame/panels/Templates/Templates'
import { framesHomeLogic } from './framesHomeLogic'

function SidebarStatusDots({ frame }: { frame: FrameType }): JSX.Element {
  const stale = frameIsStale(frame)
  const ready = frame.status === 'ready' && !stale
  const connected = (frame.active_connections ?? 0) > 0

  return (
    <span className="flex shrink-0 items-center gap-1">
      <span
        title={stale ? 'Stale' : ready ? 'Ready' : frame.status}
        className={clsx('h-2.5 w-2.5 rounded-full', stale ? 'bg-amber-400' : ready ? 'bg-emerald-400' : 'bg-slate-300')}
      />
      {connected ? <span title="Connected" className="h-2.5 w-2.5 rounded-full bg-blue-400" /> : null}
    </span>
  )
}

function FrameTree(): JSX.Element {
  const { archivedFramesExpanded } = useValues(framesModel)
  const { toggleArchivedFramesExpanded } = useActions(framesModel)
  const {
    homeActiveFramesList: activeFramesList,
    homeInactiveFramesList: inactiveFramesList,
    orderedArchivedFramesList: archivedFramesList,
    selectedFrameId,
  } = useValues(workspaceLogic)
  const { focusFrame } = useActions(workspaceLogic)

  return (
    <div className="space-y-5">
      <FrameTreeGroup title="Active" frames={activeFramesList} selectedFrameId={selectedFrameId} onFocus={focusFrame} />
      <FrameTreeGroup
        title="Inactive"
        frames={inactiveFramesList}
        selectedFrameId={selectedFrameId}
        onFocus={focusFrame}
      />
      {archivedFramesList.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={toggleArchivedFramesExpanded}
            aria-expanded={archivedFramesExpanded}
            className="homey-icon-button mb-2 flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
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
                <button
                  key={frame.id}
                  type="button"
                  onClick={() => focusFrame(frame.id)}
                  className={clsx(
                    'homey-frame-row homey-frame-row-archived flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                    selectedFrameId === frame.id
                      ? 'homey-frame-row-selected bg-blue-50 text-blue-600'
                      : 'text-slate-500 hover:bg-slate-100'
                  )}
                >
                  <ComputerDesktopIcon className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{frame.name || frameHost(frame)}</span>
                  <SidebarStatusDots frame={frame} />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function FrameTreeGroup({
  title,
  frames,
  selectedFrameId,
  onFocus,
}: {
  title: string
  frames: FrameType[]
  selectedFrameId: number | null
  onFocus: (frameId: number) => void
}): JSX.Element | null {
  if (frames.length === 0) {
    return null
  }

  return (
    <div>
      <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {title} ({frames.length})
      </div>
      <div className="space-y-1">
        {frames.map((frame) => (
          <button
            key={frame.id}
            type="button"
            onClick={() => onFocus(frame.id)}
            className={clsx(
              'homey-frame-row flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              selectedFrameId === frame.id
                ? 'homey-frame-row-selected bg-blue-50 text-blue-600'
                : 'text-slate-700 hover:bg-slate-100'
            )}
          >
            <ComputerDesktopIcon className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-base font-medium">{frame.name || frameHost(frame)}</span>
            <SidebarStatusDots frame={frame} />
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-slate-300" />
          </button>
        ))}
      </div>
    </div>
  )
}

function SceneTile({ frame, scene }: { frame: FrameType; scene: FrameScene }): JSX.Element {
  const { openSceneControl } = useActions(workspaceLogic)
  const { hideForm } = useActions(newFrameForm)
  const fieldCount = scene.fields?.filter((field) => field.access === 'public').length ?? 0

  return (
    <button
      type="button"
      onClick={() => {
        hideForm()
        openSceneControl(frame.id, scene.id)
      }}
      className="homey-card group flex h-40 w-40 shrink-0 flex-col overflow-hidden rounded-2xl border border-white/90 bg-white text-left shadow-lg shadow-slate-300/35 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-300/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
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

export function AddSceneTile({ frame, compact = false }: { frame: FrameType; compact?: boolean }): JSX.Element {
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
        'homey-card group flex shrink-0 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white/55 text-center text-slate-500 shadow-sm transition hover:-translate-y-0.5 hover:bg-white/80 hover:text-blue-500 hover:shadow-lg hover:shadow-slate-300/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        compact ? 'h-36 w-36' : 'h-40 w-40'
      )}
    >
      <span className="homey-icon-tile flex h-12 w-12 items-center justify-center rounded-full bg-white/80 text-slate-400 shadow-sm transition group-hover:text-blue-500">
        <PlusIcon className="h-7 w-7" />
      </span>
      <span className="homey-strong text-sm font-semibold text-slate-700">Add scene</span>
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
    <div className="homey-drawer fixed bottom-5 right-5 top-5 z-40 w-[430px] max-w-[calc(100vw-40px)] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <BindLogic logic={frameLogic} props={frameLogicProps}>
        <BindLogic logic={panelsLogic} props={frameLogicProps}>
          <div className="flex h-full flex-col">
            <div className="homey-divider flex items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
              <div className="min-w-0">
                <div className="homey-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {frame.name || frameHost(frame)}
                </div>
                <h2 className="homey-strong truncate text-xl font-bold tracking-normal text-slate-950">Add scene</h2>
              </div>
              <button
                type="button"
                onClick={closeTemplateDrawer}
                className="homey-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
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
        className="homey-card group flex items-center gap-3 rounded-2xl border border-white/90 bg-white/80 px-4 py-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-lg hover:shadow-slate-300/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <span className="homey-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition group-hover:bg-blue-50 group-hover:text-blue-500">
          <PlusIcon className="h-6 w-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="homey-strong block truncate text-sm font-semibold text-slate-900">New blank scene</span>
          <span className="homey-muted block truncate text-xs text-slate-500">Start with a render event</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => {
          closeTemplateDrawer()
          openChatDrawer(frame.id, null)
        }}
        className="group flex items-center gap-3 rounded-2xl border border-blue-300/70 bg-gradient-to-br from-fuchsia-500 via-blue-500 to-cyan-400 px-4 py-3 text-left text-white shadow-lg shadow-blue-500/25 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-blue-500/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/18 text-white shadow-sm transition group-hover:bg-white/24">
          <SparklesIcon className="h-6 w-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">Generate scene</span>
          <span className="block truncate text-xs text-blue-50/90">Open AI chat for this frame</span>
        </span>
      </button>
    </div>
  )
}

function CurrentSnapshotCard({ frame }: { frame: FrameType }): JSX.Element {
  const { openFrameTool } = useActions(workspaceLogic)
  const { hideForm } = useActions(newFrameForm)

  return (
    <button
      type="button"
      onClick={() => {
        hideForm()
        openFrameTool(frame.id, 'preview')
      }}
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
    </button>
  )
}

function FrameSection({ section }: { section: OverviewFrameSection }): JSX.Element {
  const { frame, scenes, archived, frameMatchesSearch } = section
  const { search } = useValues(workspaceLogic)
  const { openChatDrawer } = useActions(workspaceLogic)
  const healthy = frameIsHealthy(frame)
  const connected = (frame.active_connections ?? 0) > 0

  return (
    <section
      id={`workspace-frame-${frame.id}`}
      data-workspace-frame-section={frame.id}
      className={clsx('scroll-mt-6', archived && 'opacity-80')}
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <A
          href={urls.frame(frame.id, 'overview')}
          className="group flex min-w-0 items-center gap-3 rounded-2xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <div className="homey-icon-tile flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/70 text-slate-700 shadow-sm">
            <ComputerDesktopIcon className="h-7 w-7" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2
                data-workspace-frame-title={frame.id}
                className="homey-strong truncate text-2xl font-bold tracking-normal text-slate-950"
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
            <div className="homey-muted truncate text-sm text-slate-500">{frameStatus(frame)}</div>
          </div>
        </A>
        <div className="flex shrink-0 items-center gap-2">
          <A
            href={urls.frame(frame.id, 'overview')}
            className="homey-secondary-button rounded-full bg-white/80 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Edit
          </A>
          <button
            type="button"
            title="Open AI chat"
            onClick={() => openChatDrawer(frame.id, null)}
            className="homey-ai-button flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 via-blue-500 to-cyan-400 text-white shadow-lg shadow-blue-500/25 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-blue-500/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <SparklesIcon className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div className="flex items-start gap-5 max-xl:flex-col">
        <CurrentSnapshotCard frame={frame} />
        {scenes.length > 0 ? (
          <div className="flex flex-wrap gap-4">
            {scenes.map((scene) => (
              <SceneTile key={scene.id} frame={frame} scene={scene} />
            ))}
            <AddSceneTile frame={frame} />
          </div>
        ) : search.trim() && frameMatchesSearch ? (
          <div className="homey-empty flex h-40 min-w-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/45 px-6 text-center text-sm font-medium text-slate-500">
            Frame matched. No scenes match this search.
          </div>
        ) : (
          <AddSceneTile frame={frame} />
        )}
      </div>
    </section>
  )
}

function FrameSectionGroup({ title, sections }: { title: string; sections: OverviewFrameSection[] }): JSX.Element | null {
  if (sections.length === 0) {
    return null
  }

  return (
    <div className="space-y-8">
      <div className="homey-muted flex items-center gap-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        <span>{title}</span>
        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500">
          {sections.length}
        </span>
      </div>
      {sections.map((section) => (
        <FrameSection key={section.frame.id} section={section} />
      ))}
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
    <div className="homey-drawer fixed bottom-5 right-5 top-5 z-40 w-[390px] max-w-[calc(100vw-40px)] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <BindLogic logic={frameLogic} props={frameLogicProps}>
        <BindLogic logic={panelsLogic} props={frameLogicProps}>
          <div className="flex h-full flex-col">
            <div className="homey-divider flex items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
              <div className="min-w-0">
                <div className="homey-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {frame.name || frameHost(frame)}
                </div>
                <h2 className="homey-strong truncate text-xl font-bold tracking-normal text-slate-950">{scene.name}</h2>
              </div>
              <button
                type="button"
                onClick={closeSceneControl}
                className="homey-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-4 overflow-hidden rounded-2xl bg-slate-100">
                <FrameImage frameId={frame.id} sceneId={scene.id} refreshable={false} className="max-h-52 w-full" />
              </div>
              <div className="homey-inset rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-slate-800">
                <ExpandedScene frameId={frame.id} sceneId={scene.id} scene={scene} showEditButton={false} />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <A
                  href={urls.scenes(frame.id, scene.id)}
                  className="flex flex-1 items-center justify-center rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  Open editor
                </A>
                <DeleteInstalledSceneButton frame={frame} scene={scene} />
              </div>
            </div>
          </div>
        </BindLogic>
      </BindLogic>
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
      className="homey-secondary-button flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/80 text-red-500 shadow-sm transition hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
      title="Delete scene"
    >
      <TrashIcon className="h-5 w-5" />
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
    <div className="homey-drawer fixed bottom-5 right-5 top-5 z-40 w-[390px] max-w-[calc(100vw-40px)] overflow-y-auto rounded-[24px] border border-white/80 bg-white/95 p-5 text-slate-900 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={hideForm}
          className="homey-icon-button flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <XMarkIcon className="h-6 w-6" />
        </button>
      </div>
      <NewFrame />
    </div>
  )
}

export function FramesHome(): JSX.Element {
  useMountedLogic(framesHomeLogic)

  const { overviewActiveFrameSections, overviewInactiveFrameSections, overviewArchivedFrameSections } =
    useValues(workspaceLogic)
  const { showForm } = useActions(newFrameForm)
  const { formVisible } = useValues(newFrameForm)
  const { closeSceneControl, closeTemplateDrawer } = useActions(workspaceLogic)
  const { sceneControlSelection, templateDrawerFrameId } = useValues(workspaceLogic)
  const { archivedFramesExpanded } = useValues(framesModel)
  const { toggleArchivedFramesExpanded } = useActions(framesModel)
  const hasFrameSections =
    overviewActiveFrameSections.length + overviewInactiveFrameSections.length + overviewArchivedFrameSections.length > 0

  return (
    <HomeyShell
      mode="frames"
      title="Frames"
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
    >
      <div className="space-y-12 pb-12">
        {hasFrameSections ? (
          <>
            <FrameSectionGroup title="Active" sections={overviewActiveFrameSections} />
            <FrameSectionGroup title="Inactive" sections={overviewInactiveFrameSections} />
            {overviewArchivedFrameSections.length > 0 ? (
              <div className="space-y-8 border-t border-slate-300/70 pt-8">
                <button
                  type="button"
                  onClick={toggleArchivedFramesExpanded}
                  aria-expanded={archivedFramesExpanded}
                  className="homey-icon-button homey-muted flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm font-semibold uppercase tracking-wide text-slate-500 transition hover:bg-white/55 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
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
    </HomeyShell>
  )
}

export default FramesHome
