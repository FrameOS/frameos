import { BindLogic, useActions, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'
import {
  ArchiveBoxIcon,
  ChevronRightIcon,
  ComputerDesktopIcon,
  PhotoIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'
import { framesModel } from '../../models/framesModel'
import { FrameImage } from '../../components/FrameImage'
import { frameHost, frameIsHealthy, frameStatus } from '../../decorators/frame'
import { urls } from '../../urls'
import { FrameScene, FrameType } from '../../types'
import { HomeyShell } from './HomeyShell'
import { workspaceLogic } from './workspaceLogic'
import { NewFrame } from '../frames/NewFrame'
import { newFrameForm } from '../frames/newFrameForm'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { ExpandedScene } from '../frame/panels/Scenes/ExpandedScene'

function FrameTree(): JSX.Element {
  const { activeFramesList, archivedFramesList } = useValues(framesModel)
  const { selectedFrameId } = useValues(workspaceLogic)
  const { focusFrame } = useActions(workspaceLogic)

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Frames</div>
        <div className="space-y-1">
          {activeFramesList.map((frame) => (
            <button
              key={frame.id}
              type="button"
              onClick={() => focusFrame(frame.id)}
              className={clsx(
                'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                selectedFrameId === frame.id ? 'bg-blue-50 text-blue-600' : 'text-slate-700 hover:bg-slate-100'
              )}
            >
              <ComputerDesktopIcon className="h-5 w-5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-base font-medium">{frame.name || frameHost(frame)}</span>
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-slate-300" />
            </button>
          ))}
        </div>
      </div>
      {archivedFramesList.length > 0 ? (
        <div>
          <div className="mb-2 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <ArchiveBoxIcon className="h-4 w-4" />
            Archived
          </div>
          <div className="space-y-1">
            {archivedFramesList.map((frame) => (
              <button
                key={frame.id}
                type="button"
                onClick={() => focusFrame(frame.id)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-slate-500 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <ComputerDesktopIcon className="h-5 w-5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{frame.name || frameHost(frame)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
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
      className="group flex h-40 w-40 shrink-0 flex-col overflow-hidden rounded-2xl border border-white/90 bg-white text-left shadow-lg shadow-slate-300/35 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-300/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-slate-100">
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
        <div className="truncate text-sm font-semibold text-slate-900">{scene.name || 'Untitled scene'}</div>
        <div className="mt-0.5 truncate text-xs text-slate-500">
          {scene.nodes?.length ?? 0} nodes
          {fieldCount > 0 ? ` · ${fieldCount} controls` : ''}
        </div>
      </div>
    </button>
  )
}

function FrameSection({ frame }: { frame: FrameType }): JSX.Element {
  const scenes = frame.scenes ?? []
  const healthy = frameIsHealthy(frame)
  const connected = (frame.active_connections ?? 0) > 0

  return (
    <section id={`workspace-frame-${frame.id}`} className="scroll-mt-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/70 text-slate-700 shadow-sm">
            <ComputerDesktopIcon className="h-7 w-7" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-2xl font-bold tracking-normal text-slate-950">
                {frame.name || frameHost(frame)}
              </h2>
              {healthy ? <span title="Frame is healthy" className="h-2.5 w-2.5 rounded-full bg-emerald-400" /> : null}
              {connected ? (
                <span title="FrameOS agent connected" className="h-2.5 w-2.5 rounded-full bg-blue-400" />
              ) : null}
            </div>
            <div className="truncate text-sm text-slate-500">{frameStatus(frame)}</div>
          </div>
        </div>
        <A
          href={urls.scenes(frame.id)}
          className="shrink-0 rounded-full bg-white/80 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          Edit
        </A>
      </div>
      {scenes.length > 0 ? (
        <div className="flex flex-wrap gap-4">
          {scenes.map((scene) => (
            <SceneTile key={scene.id} frame={frame} scene={scene} />
          ))}
        </div>
      ) : (
        <A
          href={urls.scenes(frame.id)}
          className="flex h-36 w-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/45 text-sm font-medium text-slate-500 transition hover:bg-white/75"
        >
          Add scenes
        </A>
      )}
    </section>
  )
}

function SceneControlPanel(): JSX.Element | null {
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
    <div className="fixed bottom-5 right-5 top-5 z-40 w-[390px] max-w-[calc(100vw-40px)] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <BindLogic logic={frameLogic} props={frameLogicProps}>
        <BindLogic logic={panelsLogic} props={frameLogicProps}>
          <div className="flex h-full flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {frame.name || frameHost(frame)}
                </div>
                <h2 className="truncate text-xl font-bold tracking-normal text-slate-950">{scene.name}</h2>
              </div>
              <button
                type="button"
                onClick={closeSceneControl}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-4 overflow-hidden rounded-2xl bg-slate-100">
                <FrameImage frameId={frame.id} sceneId={scene.id} refreshable={false} className="max-h-52 w-full" />
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-slate-800">
                <ExpandedScene frameId={frame.id} sceneId={scene.id} scene={scene} showEditButton={false} />
              </div>
              <A
                href={urls.scenes(frame.id, scene.id)}
                className="mt-4 flex items-center justify-center rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Open editor
              </A>
            </div>
          </div>
        </BindLogic>
      </BindLogic>
    </div>
  )
}

function AddFramePanel(): JSX.Element | null {
  const { formVisible } = useValues(newFrameForm)
  const { hideForm } = useActions(newFrameForm)

  if (!formVisible) {
    return null
  }

  return (
    <div className="fixed bottom-5 right-5 top-5 z-40 w-[390px] max-w-[calc(100vw-40px)] overflow-y-auto rounded-[24px] border border-white/80 bg-white/95 p-5 text-slate-900 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={hideForm}
          className="flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <XMarkIcon className="h-6 w-6" />
        </button>
      </div>
      <NewFrame />
    </div>
  )
}

export function FramesHome(): JSX.Element {
  const { filteredOverviewFrames } = useValues(workspaceLogic)
  const { showForm } = useActions(newFrameForm)
  const { formVisible } = useValues(newFrameForm)

  return (
    <HomeyShell
      mode="frames"
      title="Frames"
      subtitle={`${filteredOverviewFrames.length} active frame${filteredOverviewFrames.length === 1 ? '' : 's'}`}
      tree={<FrameTree />}
      primaryActionLabel="Add frame"
      onPrimaryAction={showForm}
      rightPanel={formVisible ? <AddFramePanel /> : <SceneControlPanel />}
    >
      <div className="space-y-12 pb-12">
        {filteredOverviewFrames.length > 0 ? (
          filteredOverviewFrames.map((frame) => <FrameSection key={frame.id} frame={frame} />)
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
