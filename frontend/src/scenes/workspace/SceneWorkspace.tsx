import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import clsx from 'clsx'
import {
  AdjustmentsHorizontalIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  CircleStackIcon,
  CodeBracketIcon,
  CommandLineIcon,
  CubeTransparentIcon,
  DocumentTextIcon,
  EyeIcon,
  ListBulletIcon,
  PhotoIcon,
  RectangleGroupIcon,
  ServerStackIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { FrameScene, FrameType, NodeData } from '../../types'
import { urls } from '../../urls'
import { HomeyShell } from './HomeyShell'
import { sceneWorkspaceLogic } from './sceneWorkspaceLogic'
import { workspaceLogic, WorkspaceUtilityPanel } from './workspaceLogic'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { Diagram } from '../frame/panels/Diagram/Diagram'
import { diagramLogic } from '../frame/panels/Diagram/diagramLogic'
import { assetsLogic } from '../frame/panels/Assets/assetsLogic'
import { terminalLogic } from '../frame/panels/Terminal/terminalLogic'
import { frameSettingsLogic } from '../frame/panels/FrameSettings/frameSettingsLogic'
import { logsLogic } from '../frame/panels/Logs/logsLogic'
import { Apps } from '../frame/panels/Apps/Apps'
import { Assets } from '../frame/panels/Assets/Assets'
import { Events } from '../frame/panels/Events/Events'
import { FrameSettings } from '../frame/panels/FrameSettings/FrameSettings'
import { Image } from '../frame/panels/Image/Image'
import { Logs } from '../frame/panels/Logs/Logs'
import { Metrics } from '../frame/panels/Metrics/Metrics'
import { SceneJSON } from '../frame/panels/SceneJSON/SceneJSON'
import { SceneSource } from '../frame/panels/SceneSource/SceneSource'
import { SceneState } from '../frame/panels/SceneState/SceneState'
import { Schedule } from '../frame/panels/Schedule/Schedule'
import { Templates } from '../frame/panels/Templates/Templates'
import { EditTemplateModal } from '../frame/panels/Templates/EditTemplateModal'
import { Terminal } from '../frame/panels/Terminal/Terminal'
import { ExpandedScene } from '../frame/panels/Scenes/ExpandedScene'

interface SceneWorkspaceProps {
  frameId?: string
  sceneId?: string
}

interface SceneWorkspaceFrameProps {
  frameId: number
}

interface UtilityDefinition {
  panel: WorkspaceUtilityPanel
  label: string
  icon: JSX.Element
}

const utilityDefinitions: UtilityDefinition[] = [
  { panel: 'state', label: 'State', icon: <PlayIcon className="h-5 w-5" /> },
  { panel: 'apps', label: 'Apps', icon: <CubeTransparentIcon className="h-5 w-5" /> },
  { panel: 'events', label: 'Events', icon: <ListBulletIcon className="h-5 w-5" /> },
  { panel: 'templates', label: 'Templates', icon: <RectangleGroupIcon className="h-5 w-5" /> },
  { panel: 'schedule', label: 'Schedule', icon: <CalendarDaysIcon className="h-5 w-5" /> },
  { panel: 'preview', label: 'Preview', icon: <EyeIcon className="h-5 w-5" /> },
  { panel: 'logs', label: 'Logs', icon: <DocumentTextIcon className="h-5 w-5" /> },
  { panel: 'metrics', label: 'Metrics', icon: <ChartBarIcon className="h-5 w-5" /> },
  { panel: 'assets', label: 'Assets', icon: <CircleStackIcon className="h-5 w-5" /> },
  { panel: 'terminal', label: 'Terminal', icon: <CommandLineIcon className="h-5 w-5" /> },
  { panel: 'settings', label: 'Frame', icon: <AdjustmentsHorizontalIcon className="h-5 w-5" /> },
  { panel: 'source', label: 'Source', icon: <CodeBracketIcon className="h-5 w-5" /> },
  { panel: 'json', label: 'JSON', icon: <ServerStackIcon className="h-5 w-5" /> },
]

function nodeLabel(nodeData: NodeData | undefined, fallback: string): string {
  if (!nodeData) {
    return fallback
  }
  if ('name' in nodeData && nodeData.name) {
    return nodeData.name
  }
  if ('keyword' in nodeData && nodeData.keyword) {
    return nodeData.keyword
  }
  return fallback
}

function SceneTree({
  frame,
  frames,
  scenes,
  selectedSceneId,
}: {
  frame: FrameType
  frames: FrameType[]
  scenes: FrameScene[]
  selectedSceneId: string | null
}): JSX.Element {
  const { filteredSelectedFrameScenes, selectedNodeId } = useValues(workspaceLogic)
  const { navigateToSceneFrame, navigateToScene, selectNode } = useActions(workspaceLogic)
  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? null
  const diagramActions =
    selectedSceneId !== null
      ? diagramLogic({ frameId: frame.id, sceneId: selectedSceneId, updateNodeInternals: () => {} }).actions
      : null

  return (
    <div className="space-y-5">
      <div className="px-2">
        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">Frame</label>
        <select
          value={frame.id}
          onChange={(event) => navigateToSceneFrame(parseInt(event.target.value, 10))}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-400"
        >
          {frames.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name || frameHost(candidate)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Scenes</div>
        <div className="space-y-1">
          {filteredSelectedFrameScenes.map((scene) => (
            <button
              key={scene.id}
              type="button"
              onClick={() => navigateToScene(frame.id, scene.id)}
              className={clsx(
                'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                selectedSceneId === scene.id ? 'bg-blue-50 text-blue-600' : 'text-slate-700 hover:bg-slate-100'
              )}
            >
              <PhotoIcon className="h-5 w-5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-base font-medium">{scene.name || 'Untitled scene'}</span>
              {scene.default ? (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
                  Default
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      {selectedScene ? (
        <div>
          <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Nodes</div>
          <div className="space-y-1">
            {(selectedScene.nodes ?? []).length > 0 ? (
              selectedScene.nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => {
                    selectNode(node.id)
                    diagramActions?.selectNode(node.id)
                  }}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                    selectedNodeId === node.id ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/80 text-xs font-bold uppercase text-slate-500">
                    {node.type?.slice(0, 2) ?? 'no'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{nodeLabel(node.data, node.id)}</span>
                    <span
                      className={clsx(
                        'block truncate text-xs',
                        selectedNodeId === node.id ? 'text-slate-300' : 'text-slate-400'
                      )}
                    >
                      {node.type}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-sm text-slate-400">No nodes yet.</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function UtilityToolbar(): JSX.Element {
  const { utilityPanel } = useValues(workspaceLogic)
  const { openUtilityPanel } = useActions(workspaceLogic)

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {utilityDefinitions.slice(0, 6).map((definition) => (
        <button
          key={definition.panel}
          type="button"
          title={definition.label}
          onClick={() => openUtilityPanel(definition.panel)}
          className={clsx(
            'flex h-11 w-11 items-center justify-center rounded-full border border-white/90 shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            utilityPanel === definition.panel
              ? 'bg-slate-900 text-white'
              : 'bg-white/85 text-slate-500 hover:bg-white hover:text-slate-900'
          )}
        >
          {definition.icon}
        </button>
      ))}
    </div>
  )
}

function UtilityDrawer({ frameId, scene }: { frameId: number; scene: FrameScene | null }): JSX.Element | null {
  const { utilityPanel } = useValues(workspaceLogic)
  const { closeUtilityPanel, openUtilityPanel } = useActions(workspaceLogic)
  const activeDefinition = utilityDefinitions.find((definition) => definition.panel === utilityPanel)

  if (!utilityPanel || !activeDefinition) {
    return null
  }

  const renderPanel = () => {
    if (utilityPanel === 'state') {
      return scene ? (
        <div className="space-y-6">
          <ExpandedScene frameId={frameId} sceneId={scene.id} scene={scene} showEditButton={false} />
          <div className="border-t border-white/10 pt-5">
            <SceneState />
          </div>
        </div>
      ) : (
        <div>Select a scene first.</div>
      )
    }
    if (utilityPanel === 'apps') return <Apps />
    if (utilityPanel === 'events') return <Events />
    if (utilityPanel === 'templates') return <Templates />
    if (utilityPanel === 'schedule') return <Schedule />
    if (utilityPanel === 'logs') return <Logs />
    if (utilityPanel === 'metrics') return <Metrics />
    if (utilityPanel === 'assets') return <Assets />
    if (utilityPanel === 'terminal') return <Terminal />
    if (utilityPanel === 'settings') return <FrameSettings />
    if (utilityPanel === 'preview') return <Image className="h-full min-h-[22rem]" />
    if (utilityPanel === 'source') return <SceneSource />
    if (utilityPanel === 'json') return scene ? <SceneJSON sceneId={scene.id} /> : <div>Select a scene first.</div>
    return null
  }

  return (
    <div className="fixed bottom-5 right-5 top-5 z-40 flex w-[430px] max-w-[calc(100vw-40px)] overflow-hidden rounded-[24px] border border-slate-800 bg-slate-950 text-white shadow-2xl shadow-slate-500/30">
      <div className="flex w-[72px] shrink-0 flex-col items-center gap-2 border-r border-white/10 py-4">
        {utilityDefinitions.map((definition) => (
          <button
            key={definition.panel}
            type="button"
            title={definition.label}
            onClick={() => openUtilityPanel(definition.panel)}
            className={clsx(
              'flex h-11 w-11 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              utilityPanel === definition.panel
                ? 'bg-blue-500 text-white'
                : 'text-slate-400 hover:bg-white/10 hover:text-white'
            )}
          >
            {definition.icon}
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tools</div>
            <h2 className="truncate text-xl font-bold tracking-normal">{activeDefinition.label}</h2>
          </div>
          <button
            type="button"
            onClick={closeUtilityPanel}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{renderPanel()}</div>
      </div>
    </div>
  )
}

function SceneCanvas({ frameId, selectedSceneId }: { frameId: number; selectedSceneId: string | null }): JSX.Element {
  const { openUtilityPanel } = useActions(workspaceLogic)

  if (!selectedSceneId) {
    return (
      <div className="flex h-[70vh] items-center justify-center rounded-[24px] border border-white/80 bg-white/55 text-slate-500 shadow-lg shadow-slate-300/25">
        <div className="text-center">
          <PhotoIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <div className="text-lg font-semibold text-slate-700">No scene selected</div>
          <div className="text-sm text-slate-500">Choose a scene from the left panel.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-9rem)] min-h-[34rem] overflow-hidden rounded-[24px] border border-white/90 bg-white shadow-xl shadow-slate-300/30">
      <Diagram sceneId={selectedSceneId} />
      <button
        type="button"
        onClick={() => openUtilityPanel('apps')}
        className="fixed bottom-9 left-[500px] z-20 hidden rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 lg:block"
      >
        Add nodes
      </button>
    </div>
  )
}

function SceneWorkspaceFrame({ frameId }: SceneWorkspaceFrameProps): JSX.Element {
  const frameLogicProps = { frameId }
  useMountedLogic(assetsLogic(frameLogicProps))
  useMountedLogic(terminalLogic(frameLogicProps))
  useMountedLogic(frameSettingsLogic(frameLogicProps))
  useMountedLogic(logsLogic(frameLogicProps))

  const { framesList } = useValues(framesModel)
  const { frame, scenes, unsavedChanges, undeployedChanges, requiresRecompilation } = useValues(
    frameLogic(frameLogicProps)
  )
  const { selectedSceneId } = useValues(workspaceLogic)
  const { saveFrame, saveAndDeployFrame } = useActions(frameLogic(frameLogicProps))
  const { openUtilityPanel } = useActions(workspaceLogic)

  if (!frame) {
    return (
      <HomeyShell mode="scenes" title="Scenes" tree={<div className="px-3 py-2 text-slate-400">Loading...</div>}>
        <div className="flex h-[60vh] items-center justify-center text-slate-500">Loading frame...</div>
      </HomeyShell>
    )
  }

  const resolvedSceneId =
    selectedSceneId && scenes.some((scene) => scene.id === selectedSceneId) ? selectedSceneId : scenes[0]?.id ?? null
  const selectedScene = scenes.find((scene) => scene.id === resolvedSceneId) ?? null

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      <BindLogic logic={panelsLogic} props={frameLogicProps}>
        <HomeyShell
          mode="scenes"
          title="Scenes"
          subtitle={frame.name || frameHost(frame)}
          tree={<SceneTree frame={frame} frames={framesList} scenes={scenes} selectedSceneId={resolvedSceneId} />}
          toolbar={<UtilityToolbar />}
          rightPanel={<UtilityDrawer frameId={frameId} scene={selectedScene} />}
        >
          <div className="pb-12">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 className="truncate text-3xl font-bold tracking-normal text-slate-950">
                  {selectedScene?.name || 'Untitled scene'}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                  <span>{scenes.length} scenes</span>
                  <span>{selectedScene?.nodes?.length ?? 0} nodes</span>
                  {selectedScene?.settings?.execution === 'interpreted' ? (
                    <span>Interpreted</span>
                  ) : (
                    <span>Compiled</span>
                  )}
                  {unsavedChanges ? <span className="font-semibold text-amber-600">Unsaved</span> : null}
                  {!unsavedChanges && undeployedChanges ? (
                    <span className="font-semibold text-blue-600">Undeployed</span>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => openUtilityPanel('state')}
                  className="rounded-full bg-white/85 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  Run
                </button>
                <button
                  type="button"
                  onClick={() => saveFrame()}
                  className={clsx(
                    'rounded-full px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                    unsavedChanges
                      ? 'bg-blue-500 text-white hover:bg-blue-600'
                      : 'bg-white/85 text-slate-700 hover:bg-white'
                  )}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    saveAndDeployFrame()
                    openUtilityPanel('logs')
                  }}
                  className={clsx(
                    'rounded-full px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                    unsavedChanges || undeployedChanges
                      ? 'bg-slate-900 text-white hover:bg-slate-700'
                      : 'bg-white/85 text-slate-700 hover:bg-white'
                  )}
                >
                  {requiresRecompilation ? 'Full deploy' : 'Deploy'}
                </button>
              </div>
            </div>
            <SceneCanvas frameId={frameId} selectedSceneId={resolvedSceneId} />
          </div>
        </HomeyShell>
        <EditTemplateModal />
      </BindLogic>
    </BindLogic>
  )
}

export function SceneWorkspace({ frameId, sceneId }: SceneWorkspaceProps): JSX.Element {
  useMountedLogic(sceneWorkspaceLogic({ routeFrameId: frameId ?? null, routeSceneId: sceneId ?? null }))
  const { selectedFrame } = useValues(workspaceLogic)
  const { activeFramesList } = useValues(framesModel)
  const firstFrame = selectedFrame ?? activeFramesList[0] ?? null

  if (!firstFrame) {
    return (
      <HomeyShell
        mode="scenes"
        title="Scenes"
        subtitle="No frames"
        tree={<div className="px-3 py-2 text-slate-400">Add a frame before editing scenes.</div>}
      >
        <div className="flex h-[60vh] items-center justify-center rounded-[24px] border border-white/80 bg-white/55 text-slate-500 shadow-lg shadow-slate-300/25">
          No frames available.
        </div>
      </HomeyShell>
    )
  }

  return <SceneWorkspaceFrame frameId={firstFrame.id} />
}

export default SceneWorkspace
