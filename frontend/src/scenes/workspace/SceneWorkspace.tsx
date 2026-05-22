import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import clsx from 'clsx'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CodeBracketIcon,
  CubeTransparentIcon,
  ListBulletIcon,
  PhotoIcon,
  RectangleGroupIcon,
  ServerStackIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'
import { FrameImage } from '../../components/FrameImage'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { FrameScene, FrameType, NodeData } from '../../types'
import { HomeyShell } from './HomeyShell'
import { sceneWorkspaceLogic } from './sceneWorkspaceLogic'
import { workspaceLogic, WorkspaceUtilityPanel } from './workspaceLogic'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { Diagram, DiagramToolbar } from '../frame/panels/Diagram/Diagram'
import { diagramLogic } from '../frame/panels/Diagram/diagramLogic'
import { Apps } from '../frame/panels/Apps/Apps'
import { Events } from '../frame/panels/Events/Events'
import { SceneJSON } from '../frame/panels/SceneJSON/SceneJSON'
import { SceneSource } from '../frame/panels/SceneSource/SceneSource'
import { SceneState } from '../frame/panels/SceneState/SceneState'
import { scenesLogic } from '../frame/panels/Scenes/scenesLogic'
import { EditTemplateModal } from '../frame/panels/Templates/EditTemplateModal'
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

function SceneSelector({
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
  const { navigateToScene, navigateToSceneFrame } = useActions(workspaceLogic)

  return (
    <div className="space-y-3 px-2">
      <div>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">Frame</label>
        <select
          value={frame.id}
          onChange={(event) => navigateToSceneFrame(parseInt(event.target.value, 10))}
          className="homey-form-control min-h-12 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-400"
        >
          {frames.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name || frameHost(candidate)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">Scene</label>
        <select
          value={selectedSceneId ?? ''}
          onChange={(event) => {
            if (event.target.value) {
              navigateToScene(frame.id, event.target.value)
            }
          }}
          className="homey-form-control min-h-12 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-400"
        >
          {scenes.length === 0 ? (
            <option value="">No scenes</option>
          ) : (
            scenes.map((scene) => (
              <option key={scene.id} value={scene.id}>
                {scene.name || 'Untitled scene'}
              </option>
            ))
          )}
        </select>
      </div>
    </div>
  )
}

function SceneTree({
  frame,
  frames,
  scenes,
  selectedScene,
  selectedSceneId,
  unsavedChanges,
  undeployedChanges,
}: {
  frame: FrameType
  frames: FrameType[]
  scenes: FrameScene[]
  selectedScene: FrameScene | null
  selectedSceneId: string | null
  unsavedChanges: boolean
  undeployedChanges: boolean
}): JSX.Element {
  const { sceneNodesOpen, selectedNodeId } = useValues(workspaceLogic)
  const { openUtilityPanel, selectNode, toggleSceneNodesOpen } = useActions(workspaceLogic)
  const { saveFrame, saveAndDeployFrame } = useActions(frameLogic({ frameId: frame.id }))
  const { linkedActiveSceneId } = useValues(scenesLogic({ frameId: frame.id }))
  const diagramActions =
    selectedSceneId !== null
      ? diagramLogic({ frameId: frame.id, sceneId: selectedSceneId, updateNodeInternals: () => {} }).actions
      : null
  const sceneNodes = selectedScene?.nodes ?? []
  const execution = selectedScene?.settings?.execution === 'interpreted' ? 'Interpreted' : 'Compiled'
  const selectedSceneIsActive = selectedSceneId !== null && linkedActiveSceneId === selectedSceneId

  return (
    <div className="space-y-5">
      <SceneSelector frame={frame} frames={frames} scenes={scenes} selectedSceneId={selectedSceneId} />
      <div className="homey-inset mx-2 rounded-2xl border border-slate-200 bg-white/55 p-3">
        <div className="homey-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
          {frame.name || frameHost(frame)}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">
            {sceneNodes.length} nodes
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">{execution}</span>
          {unsavedChanges ? (
            <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-700">Unsaved</span>
          ) : null}
          {!unsavedChanges && undeployedChanges ? (
            <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">Undeployed</span>
          ) : null}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => openUtilityPanel('state')}
            className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Run
          </button>
          <button
            type="button"
            onClick={() => saveFrame()}
            className={clsx(
              'rounded-full px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              unsavedChanges ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-white text-slate-700 hover:bg-slate-100'
            )}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => saveAndDeployFrame()}
            className={clsx(
              'rounded-full px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              unsavedChanges || undeployedChanges
                ? 'bg-slate-900 text-white hover:bg-slate-700'
                : 'bg-white text-slate-700 hover:bg-slate-100'
            )}
          >
            Deploy
          </button>
        </div>
      </div>
      {selectedScene ? (
        <div className="homey-card mx-2 overflow-hidden rounded-2xl border border-white/80 bg-white/65 shadow-sm">
          <div className="homey-card-media relative h-32 bg-slate-100">
            <FrameImage
              frameId={frame.id}
              sceneId={selectedSceneIsActive ? undefined : selectedScene.id}
              refreshable
              objectFit="contain"
              className="h-full w-full"
            />
            <div className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-slate-500 shadow-sm">
              {selectedSceneIsActive ? 'Current' : 'Scene'}
            </div>
          </div>
        </div>
      ) : null}
      {selectedScene ? (
        <div>
          <button
            type="button"
            onClick={toggleSceneNodesOpen}
            className="homey-icon-button mb-2 flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            aria-expanded={sceneNodesOpen}
          >
            {sceneNodesOpen ? <ChevronDownIcon className="h-4 w-4" /> : <ChevronRightIcon className="h-4 w-4" />}
            <span className="flex-1">Nodes</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
              {sceneNodes.length}
            </span>
          </button>
          {sceneNodesOpen ? (
            <div className="space-y-1">
              {sceneNodes.length > 0 ? (
                sceneNodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => {
                      selectNode(node.id)
                      diagramActions?.selectNode(node.id)
                    }}
                    className={clsx(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                      selectedNodeId === node.id
                        ? 'bg-slate-900 text-white'
                        : 'homey-strong text-slate-700 hover:bg-slate-100'
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
                          selectedNodeId === node.id ? 'text-slate-300' : 'homey-muted text-slate-400'
                        )}
                      >
                        {node.type}
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                <div className="homey-muted px-3 py-2 text-sm text-slate-400">
                  No nodes yet. Add one from the tools above.
                </div>
              )}
            </div>
          ) : null}
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

function SceneEditorTopBar({ sceneId }: { sceneId: string | null }): JSX.Element {
  return (
    <div className="mb-4 flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch">
      <div className="flex min-w-0 items-center gap-2">{sceneId ? <DiagramToolbar sceneId={sceneId} /> : null}</div>
      <UtilityToolbar />
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

function SceneCanvas({ selectedSceneId }: { selectedSceneId: string | null }): JSX.Element {
  const { openUtilityPanel } = useActions(workspaceLogic)

  if (!selectedSceneId) {
    return (
      <div className="flex h-[calc(100vh-6rem)] items-center justify-center rounded-[24px] border border-white/80 bg-white/55 text-slate-500 shadow-lg shadow-slate-300/25">
        <div className="text-center">
          <PhotoIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <div className="text-lg font-semibold text-slate-700">No scene selected</div>
          <div className="text-sm text-slate-500">Choose a scene from the left panel.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="scene-editor-canvas h-[calc(100vh-5.25rem)] min-h-[34rem] overflow-hidden">
      <Diagram sceneId={selectedSceneId} showToolbar={false} />
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
  const { frame, scenes, unsavedChanges, undeployedChanges } = useValues(frameLogic(frameLogicProps))
  const { framesList } = useValues(framesModel)
  const { selectedSceneId } = useValues(workspaceLogic)

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
          tree={
            <SceneTree
              frame={frame}
              frames={framesList}
              scenes={scenes}
              selectedScene={selectedScene}
              selectedSceneId={resolvedSceneId}
              unsavedChanges={unsavedChanges}
              undeployedChanges={undeployedChanges}
            />
          }
          topBar={<SceneEditorTopBar sceneId={resolvedSceneId} />}
          mainClassName="h-screen overflow-hidden py-5 pl-[456px] pr-5 max-lg:h-auto max-lg:overflow-visible max-lg:px-4"
          rightPanel={<UtilityDrawer frameId={frameId} scene={selectedScene} />}
        >
          <SceneCanvas selectedSceneId={resolvedSceneId} />
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
