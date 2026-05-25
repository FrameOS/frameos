import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import clsx from 'clsx'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CodeBracketIcon,
  CodeBracketSquareIcon,
  EyeIcon,
  ListBulletIcon,
  PhotoIcon,
  ServerStackIcon,
  SparklesIcon,
  VariableIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import type { DragEvent } from 'react'
import { FrameImage } from '../../components/FrameImage'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { FrameScene, FrameType, NodeData } from '../../types'
import { FrameosShell } from './FrameosShell'
import { FrameDeployPlanDrawer } from './FrameDeployPlanDrawer'
import { FrameUnsavedChangesDrawer } from './FrameUnsavedChangesDrawer'
import { FrameSceneSidebarCard } from './FrameSceneSidebarCard'
import { FrameSidebarPreview } from './FrameSidebarPreview'
import { sceneWorkspaceLogic } from './sceneWorkspaceLogic'
import { workspaceLogic, WorkspaceUtilityPanel } from './workspaceLogic'
import { frameLogic } from '../frame/frameLogic'
import { panelsLogic } from '../frame/panels/panelsLogic'
import { Diagram, DiagramToolbar } from '../frame/panels/Diagram/Diagram'
import { buildDiagramNodeTreeItems, diagramLogic, type DiagramNodeTreeItem } from '../frame/panels/Diagram/diagramLogic'
import { Apps } from '../frame/panels/Apps/Apps'
import { Events } from '../frame/panels/Events/Events'
import { SceneJSON } from '../frame/panels/SceneJSON/SceneJSON'
import { SceneSource } from '../frame/panels/SceneSource/SceneSource'
import { SceneState } from '../frame/panels/SceneState/SceneState'
import { scenesLogic } from '../frame/panels/Scenes/scenesLogic'
import { EditTemplateModal } from '../frame/panels/Templates/EditTemplateModal'
import { ExpandedScene } from '../frame/panels/Scenes/ExpandedScene'
import { SceneDropDown } from '../frame/panels/Scenes/SceneDropDown'
import { getFrameosSceneDragData, hasFrameosSceneDragData, setFrameosSceneDragData } from './sceneDrag'
import { groupFramesByStatus } from './frameStatusGroups'

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
  { panel: 'state', label: 'Preview', icon: <EyeIcon className="h-5 w-5" /> },
  { panel: 'stateVariables', label: 'State variables', icon: <VariableIcon className="h-5 w-5" /> },
  { panel: 'apps', label: 'Apps', icon: <CodeBracketSquareIcon className="h-5 w-5" /> },
  { panel: 'events', label: 'Events', icon: <ListBulletIcon className="h-5 w-5" /> },
  { panel: 'source', label: 'Source', icon: <CodeBracketIcon className="h-5 w-5" /> },
  { panel: 'json', label: 'JSON', icon: <ServerStackIcon className="h-5 w-5" /> },
]

function sceneIsCompiled(scene: FrameScene | null): boolean {
  return !!scene && scene.settings?.execution !== 'interpreted'
}

function sceneUtilityDefinitions(scene: FrameScene | null): UtilityDefinition[] {
  return utilityDefinitions.filter((definition) => definition.panel !== 'source' || sceneIsCompiled(scene))
}

function sceneUtilityDefinition(
  panel: WorkspaceUtilityPanel | null,
  scene: FrameScene | null
): UtilityDefinition | null {
  return sceneUtilityDefinitions(scene).find((definition) => definition.panel === panel) ?? null
}

function selectedSceneFirst(scenes: FrameScene[], selectedSceneId: string | null): FrameScene[] {
  if (!selectedSceneId) {
    return scenes
  }
  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId)
  if (!selectedScene) {
    return scenes
  }
  return [selectedScene, ...scenes.filter((scene) => scene.id !== selectedSceneId)]
}

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

function nodeKindLabel(item: DiagramNodeTreeItem): string {
  if (item.kind === 'root') {
    return 'root event'
  }
  if (item.kind === 'disconnected') {
    return `${item.node.type} · disconnected`
  }
  return item.node.type ?? item.kind
}

function SceneSelector({
  frame,
  frames,
  scenes,
  selectedSceneId,
  sidebarActions,
}: {
  frame: FrameType
  frames: FrameType[]
  scenes: FrameScene[]
  selectedSceneId: string | null
  sidebarActions?: JSX.Element
}): JSX.Element {
  const { navigateToScene, navigateToSceneFrame } = useActions(workspaceLogic)
  const { linkedActiveSceneId, undeployedSceneIds, unsavedSceneIds } = useValues(scenesLogic({ frameId: frame.id }))
  const frameGroups = groupFramesByStatus(frames)

  const handleSceneListDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFrameosSceneDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const handleSceneListDrop = (event: DragEvent<HTMLDivElement>) => {
    const sceneId = getFrameosSceneDragData(event.dataTransfer)
    if (!sceneId || !scenes.some((scene) => scene.id === sceneId)) {
      return
    }
    event.preventDefault()
    navigateToScene(frame.id, sceneId)
  }

  return (
    <div className="@container space-y-2">
      <div className="grid gap-2 @xs:grid-cols-[6.5rem_minmax(0,1fr)] @xs:items-stretch">
        <FrameSidebarPreview
          frame={frame}
          className="order-3 @xs:order-1 @xs:h-full"
          mediaClassName="@xs:h-full @xs:min-h-[6.75rem]"
        />
        <div className="order-1 min-w-0 space-y-2 @xs:order-2">
          <div>
            <label className="frameos-muted mb-2 block text-xs font-semibold uppercase tracking-wide">Frame</label>
            <select
              value={frame.id}
              onChange={(event) => navigateToSceneFrame(parseInt(event.target.value, 10))}
              className="frameos-form-control w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-400"
            >
              {frameGroups.map((group) => (
                <optgroup key={group.key} label={group.label}>
                  {group.frames.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name || frameHost(candidate)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {sidebarActions}
        </div>
      </div>
      <div onDragOver={handleSceneListDragOver} onDrop={handleSceneListDrop}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <label className="frameos-muted block text-xs font-semibold uppercase tracking-wide">Scenes</label>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
            {scenes.length}
          </span>
        </div>
        {scenes.length === 0 ? (
          <div className="frameos-muted rounded-xl px-3 py-2 text-sm text-slate-400">No scenes</div>
        ) : (
          <div className="space-y-1">
            {scenes.map((scene) => {
              const selected = scene.id === selectedSceneId
              const active = scene.id === linkedActiveSceneId
              const changed = unsavedSceneIds.has(scene.id) || undeployedSceneIds.has(scene.id)

              return (
                <div
                  key={scene.id}
                  draggable
                  onDragStart={(event) => setFrameosSceneDragData(event.dataTransfer, scene.id)}
                  className={clsx(
                    'group flex items-center gap-1.5 rounded-xl transition',
                    selected ? 'frameos-primary-soft-active' : 'frameos-frame-row text-slate-700'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => navigateToScene(frame.id, scene.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  >
                    <span className="frameos-card-media relative h-10 w-12 shrink-0 overflow-hidden rounded-lg border border-white/70 bg-slate-100 shadow-sm">
                      <FrameImage
                        frameId={frame.id}
                        sceneId={scene.id}
                        thumb
                        refreshable={false}
                        objectFit="cover"
                        className="h-full w-full rounded-none"
                      />
                      <span
                        className={clsx(
                          'absolute bottom-1 right-1 h-2.5 w-2.5 rounded-full ring-2 ring-white',
                          active ? 'frameos-primary-fill' : changed ? 'bg-amber-400' : 'bg-slate-300'
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="frameos-strong block truncate text-sm font-semibold text-slate-700">
                        {scene.name || 'Untitled scene'}
                      </span>
                      <span className="frameos-muted block truncate text-xs text-slate-400">
                        {scene.nodes?.length ?? 0} nodes{active ? ' · active' : ''}
                      </span>
                    </span>
                  </button>
                  <div className="pr-1">
                    <SceneDropDown context="scenes" sceneId={scene.id} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
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
  const { sceneNodesOpen } = useValues(workspaceLogic)
  const { toggleSceneNodesOpen } = useActions(workspaceLogic)
  const sceneNodes = selectedScene?.nodes ?? []

  return (
    <div className="space-y-4">
      <SceneSelector
        frame={frame}
        frames={frames}
        scenes={scenes}
        selectedSceneId={selectedSceneId}
        sidebarActions={
          <FrameSceneSidebarCard frame={frame} unsavedChanges={unsavedChanges} undeployedChanges={undeployedChanges} />
        }
      />
      {selectedScene ? (
        <div>
          <button
            type="button"
            onClick={toggleSceneNodesOpen}
            className="frameos-icon-button mb-1 flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            aria-expanded={sceneNodesOpen}
          >
            {sceneNodesOpen ? <ChevronDownIcon className="h-4 w-4" /> : <ChevronRightIcon className="h-4 w-4" />}
            <span className="flex-1">Nodes</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
              {sceneNodes.length}
            </span>
          </button>
          {sceneNodesOpen ? selectedSceneId ? <SceneNodesList frameId={frame.id} scene={selectedScene} /> : null : null}
        </div>
      ) : null}
    </div>
  )
}

function SceneNodesList({ frameId, scene }: { frameId: number; scene: FrameScene }): JSX.Element {
  const { selectedNodeId } = useValues(workspaceLogic)
  const { selectNode } = useActions(workspaceLogic)
  const nodeTreeItems = buildDiagramNodeTreeItems(scene.nodes ?? [], scene.edges ?? [])
  const diagram = diagramLogic({ frameId, sceneId: scene.id })
  const { selectedNodeIds } = useValues(diagram)
  const diagramActions = diagram.actions
  const highlightedNodeIds = new Set(
    selectedNodeIds.length > 0 ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : []
  )

  if (nodeTreeItems.length === 0) {
    return (
      <div className="frameos-muted px-3 py-2 text-sm text-slate-400">No nodes yet. Add one from the tools above.</div>
    )
  }

  return (
    <div className="space-y-0.5">
      {nodeTreeItems.map((item) => (
        <SceneNodeTreeButton
          key={item.node.id}
          item={item}
          highlighted={highlightedNodeIds.has(item.node.id)}
          onClick={() => {
            selectNode(item.node.id)
            diagramActions.selectNode(item.node.id)
          }}
        />
      ))}
    </div>
  )
}

function SceneNodeTreeButton({
  item,
  highlighted,
  onClick,
}: {
  item: DiagramNodeTreeItem
  highlighted: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-xl py-1.5 pr-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        highlighted ? 'frameos-primary-active' : 'frameos-strong hover:bg-white/55',
        item.kind === 'disconnected' && !highlighted && 'opacity-70'
      )}
      style={{ paddingLeft: `${12 + item.depth * 14}px` }}
    >
      {item.depth > 0 ? (
        <span className={clsx('h-px w-3 shrink-0', highlighted ? 'bg-slate-500' : 'frameos-divider bg-slate-300')} />
      ) : null}
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/80 text-xs font-bold uppercase text-slate-500">
        {item.node.type?.slice(0, 2) ?? 'no'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{nodeLabel(item.node.data, item.node.id)}</span>
        <span
          className={clsx('block truncate text-xs', highlighted ? 'text-white/75' : 'frameos-muted text-slate-400')}
        >
          {nodeKindLabel(item)}
        </span>
      </span>
    </button>
  )
}

function UtilityToolbar({ scene }: { scene: FrameScene | null }): JSX.Element {
  const { chatDrawerSelection, utilityPanel } = useValues(workspaceLogic)
  const { closeChatDrawer, openUtilityPanel } = useActions(workspaceLogic)
  const utilityPanelIsVisible = !chatDrawerSelection
  const definitions = sceneUtilityDefinitions(scene)

  return (
    <div className="scene-diagram-utility-toolbar flex shrink-0 flex-col items-center gap-2">
      {definitions.map((definition) => (
        <button
          key={definition.panel}
          type="button"
          title={definition.label}
          onClick={() => {
            closeChatDrawer()
            openUtilityPanel(definition.panel)
          }}
          className={clsx(
            'frameos-icon-button flex h-10 w-10 items-center justify-center rounded-xl border border-white/90 bg-white/90 text-slate-500 shadow-lg shadow-slate-300/25 backdrop-blur-xl transition hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            utilityPanelIsVisible && utilityPanel === definition.panel
              ? 'frameos-primary-active text-white'
              : 'bg-white/90 text-slate-500 hover:bg-white hover:text-slate-900'
          )}
        >
          {definition.icon}
        </button>
      ))}
    </div>
  )
}

function SceneDiagramOverlay({
  frameId,
  scene,
  sceneId,
}: {
  frameId: number
  scene: FrameScene | null
  sceneId: string | null
}): JSX.Element {
  const { chatDrawerSelection } = useValues(workspaceLogic)
  const { closeUtilityPanel, openChatDrawer } = useActions(workspaceLogic)
  const chatDrawerIsOpen = chatDrawerSelection?.frameId === frameId && chatDrawerSelection.sceneId === sceneId

  return (
    <div className="scene-diagram-overlay pointer-events-none absolute inset-0 z-20">
      <div className="scene-diagram-utility-buttons pointer-events-auto absolute flex shrink-0 flex-col items-center gap-2">
        <button
          type="button"
          title="Open AI chat"
          onClick={() => {
            closeUtilityPanel()
            openChatDrawer(frameId, sceneId)
          }}
          className={clsx(
            'frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/90 bg-white/90 text-slate-500 shadow-lg shadow-slate-300/25 backdrop-blur-xl transition hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            chatDrawerIsOpen && 'frameos-primary-active text-white'
          )}
        >
          <SparklesIcon className="h-5 w-5" />
        </button>
        <UtilityToolbar scene={scene} />
      </div>
      <div className="scene-diagram-node-toolbar pointer-events-auto absolute left-2 top-5 flex min-w-0 flex-wrap items-center gap-2">
        {sceneId ? <DiagramToolbar sceneId={sceneId} /> : null}
      </div>
    </div>
  )
}

function SceneTreeLoadingPlaceholder(): JSX.Element {
  return (
    <div className="space-y-4 px-2">
      <div>
        <div className="frameos-muted mb-2 text-xs font-semibold uppercase tracking-wide">Frame</div>
        <div className="frameos-skeleton-surface h-12 animate-pulse rounded-xl" />
      </div>
      <div className="frameos-inset rounded-2xl border border-slate-200 bg-white/55 p-3">
        <div className="frameos-skeleton-line h-3 w-28 animate-pulse rounded-full" />
        <div className="mt-3 flex flex-wrap gap-1.5">
          {[0, 1, 2].map((index) => (
            <div key={index} className="frameos-skeleton-line h-6 w-16 animate-pulse rounded-full" />
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="frameos-skeleton-surface h-8 animate-pulse rounded-full" />
          ))}
        </div>
      </div>
      <div className="frameos-skeleton-surface h-32 overflow-hidden rounded-2xl">
        <div className="frameos-skeleton-media h-full animate-pulse" />
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide">Scenes</div>
          <div className="frameos-skeleton-line h-5 w-8 animate-pulse rounded-full" />
        </div>
        <div className="space-y-1">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="frameos-skeleton-surface flex items-center gap-2 rounded-xl px-3 py-2">
              <div className="frameos-skeleton-media h-2.5 w-2.5 shrink-0 animate-pulse rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="frameos-skeleton-line h-3 w-32 max-w-full animate-pulse rounded-full" />
                <div className="frameos-skeleton-line h-2 w-20 max-w-full animate-pulse rounded-full opacity-70" />
              </div>
              <div className="frameos-skeleton-line h-8 w-8 shrink-0 animate-pulse rounded-xl" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-2 flex items-center gap-2 px-2">
          <div className="frameos-skeleton-media h-4 w-4 animate-pulse rounded" />
          <div className="frameos-skeleton-line h-3 w-20 animate-pulse rounded-full" />
        </div>
        <div className="space-y-1">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center gap-2 rounded-xl px-3 py-1.5">
              <div className="frameos-skeleton-surface h-8 w-8 shrink-0 animate-pulse rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="frameos-skeleton-line h-3 w-28 max-w-full animate-pulse rounded-full" />
                <div className="frameos-skeleton-line h-2 w-16 max-w-full animate-pulse rounded-full opacity-70" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SceneCanvasLoadingPlaceholder(): JSX.Element {
  return (
    <div className="scene-editor-canvas scene-editor-canvas-full h-screen min-h-screen overflow-hidden bg-white/35 p-5">
      <div className="relative h-full overflow-hidden">
        <div className="frameos-skeleton-surface absolute left-[8%] top-[12%] h-20 w-52 animate-pulse rounded-2xl" />
        <div className="frameos-skeleton-surface absolute right-[10%] top-[18%] h-20 w-52 animate-pulse rounded-2xl" />
        <div className="frameos-skeleton-surface absolute bottom-[24%] left-[26%] h-20 w-56 animate-pulse rounded-2xl" />
        <div className="frameos-skeleton-surface absolute bottom-[16%] right-[18%] h-20 w-48 animate-pulse rounded-2xl" />
        <div className="frameos-skeleton-line absolute left-[28%] top-[22%] h-1 w-[28%] rotate-6 animate-pulse rounded-full opacity-70" />
        <div className="frameos-skeleton-line absolute left-[42%] top-[46%] h-1 w-[22%] -rotate-12 animate-pulse rounded-full opacity-70" />
      </div>
    </div>
  )
}

function ScenePreviewPanel({ frameId, scene }: { frameId: number; scene: FrameScene }): JSX.Element {
  return <ExpandedScene frameId={frameId} sceneId={scene.id} scene={scene} showEditButton={false} />
}

function UtilityDrawer({ frameId, scene }: { frameId: number; scene: FrameScene | null }): JSX.Element | null {
  const { utilityPanel } = useValues(workspaceLogic)
  const { closeUtilityPanel } = useActions(workspaceLogic)
  const activeDefinition = sceneUtilityDefinition(utilityPanel, scene)

  if (!utilityPanel || !activeDefinition) {
    return null
  }

  const renderPanel = () => {
    if (utilityPanel === 'state') {
      return scene ? <ScenePreviewPanel frameId={frameId} scene={scene} /> : <div>Select a scene first.</div>
    }
    if (utilityPanel === 'stateVariables') {
      return scene ? <SceneState sceneId={scene.id} /> : <div>Select a scene first.</div>
    }
    if (utilityPanel === 'apps') return <Apps />
    if (utilityPanel === 'events') return <Events />
    if (utilityPanel === 'source') return <SceneSource />
    if (utilityPanel === 'json') return scene ? <SceneJSON sceneId={scene.id} /> : <div>Select a scene first.</div>
    return null
  }

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 flex w-[430px] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 text-slate-900 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="frameos-divider flex items-center justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
          <div className="min-w-0">
            <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-500">Tools</div>
            <h2 className="frameos-strong truncate text-xl font-bold tracking-normal text-slate-950">
              {activeDefinition.label}
            </h2>
          </div>
          <button
            type="button"
            onClick={closeUtilityPanel}
            className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{renderPanel()}</div>
      </div>
    </div>
  )
}

function SceneCanvas({
  frameId,
  selectedScene,
  selectedSceneId,
}: {
  frameId: number
  selectedScene: FrameScene | null
  selectedSceneId: string | null
}): JSX.Element {
  const { navigateToScene } = useActions(workspaceLogic)

  const handleSceneDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFrameosSceneDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const handleSceneDrop = (event: DragEvent<HTMLDivElement>) => {
    const sceneId = getFrameosSceneDragData(event.dataTransfer)
    if (!sceneId) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    navigateToScene(frameId, sceneId)
  }

  if (!selectedSceneId) {
    return (
      <div
        className="flex h-screen min-h-screen items-center justify-center bg-white/35 text-slate-500"
        onDragOver={handleSceneDragOver}
        onDrop={handleSceneDrop}
      >
        <div className="text-center">
          <PhotoIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <div className="text-lg font-semibold text-slate-700">No scene selected</div>
          <div className="text-sm text-slate-500">Choose a scene from the left panel.</div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="scene-editor-canvas scene-editor-canvas-full @container relative h-screen min-h-screen overflow-hidden"
      onDragOverCapture={handleSceneDragOver}
      onDropCapture={handleSceneDrop}
    >
      <Diagram sceneId={selectedSceneId} showToolbar={false} />
      <SceneDiagramOverlay frameId={frameId} scene={selectedScene} sceneId={selectedSceneId} />
    </div>
  )
}

function SceneWorkspaceFrame({ frameId }: SceneWorkspaceFrameProps): JSX.Element {
  const frameLogicProps = { frameId }
  const { frame, scenes, unsavedChanges, undeployedChanges, deployPlanModalOpen, unsavedChangesModalOpen } = useValues(
    frameLogic(frameLogicProps)
  )
  const { framesList } = useValues(framesModel)
  const { selectedSceneId, utilityPanel } = useValues(workspaceLogic)

  if (!frame) {
    return (
      <FrameosShell
        mode="scenes"
        title="Scenes"
        tree={<SceneTreeLoadingPlaceholder />}
        topBar={null}
        showAiButton={false}
        mainClassName="scene-workspace-main h-screen overflow-hidden p-0"
      >
        <SceneCanvasLoadingPlaceholder />
      </FrameosShell>
    )
  }

  const resolvedSceneId =
    selectedSceneId && scenes.some((scene) => scene.id === selectedSceneId) ? selectedSceneId : scenes[0]?.id ?? null
  const selectedScene = scenes.find((scene) => scene.id === resolvedSceneId) ?? null
  const sidebarScenes = selectedSceneFirst(scenes, resolvedSceneId)
  const activeUtilityDefinition = sceneUtilityDefinition(utilityPanel, selectedScene)

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      <BindLogic logic={panelsLogic} props={frameLogicProps}>
        <FrameosShell
          mode="scenes"
          title="Scenes"
          tree={
            <SceneTree
              frame={frame}
              frames={framesList}
              scenes={sidebarScenes}
              selectedScene={selectedScene}
              selectedSceneId={resolvedSceneId}
              unsavedChanges={unsavedChanges}
              undeployedChanges={undeployedChanges}
            />
          }
          topBar={null}
          showAiButton={false}
          mainClassName="scene-workspace-main h-screen overflow-hidden p-0"
          rightPanel={
            unsavedChangesModalOpen ? (
              <FrameUnsavedChangesDrawer frame={frame} />
            ) : deployPlanModalOpen ? (
              <FrameDeployPlanDrawer frame={frame} />
            ) : activeUtilityDefinition ? (
              <UtilityDrawer frameId={frameId} scene={selectedScene} />
            ) : null
          }
        >
          <SceneCanvas frameId={frame.id} selectedScene={selectedScene} selectedSceneId={resolvedSceneId} />
        </FrameosShell>
        <EditTemplateModal />
      </BindLogic>
    </BindLogic>
  )
}

export function SceneWorkspace({ frameId, sceneId }: SceneWorkspaceProps): JSX.Element {
  useMountedLogic(sceneWorkspaceLogic({ routeFrameId: frameId ?? null, routeSceneId: sceneId ?? null }))
  const { selectedFrame } = useValues(workspaceLogic)
  const { activeFramesList, framesLoading } = useValues(framesModel)
  const routeFrameId = frameId ? parseInt(frameId, 10) : null

  if (routeFrameId && Number.isFinite(routeFrameId)) {
    return <SceneWorkspaceFrame frameId={routeFrameId} />
  }

  const firstFrame = selectedFrame ?? activeFramesList[0] ?? null

  if (!firstFrame) {
    if (framesLoading) {
      return (
        <FrameosShell
          mode="scenes"
          title="Scenes"
          tree={<SceneTreeLoadingPlaceholder />}
          topBar={null}
          showAiButton={false}
          mainClassName="scene-workspace-main h-screen overflow-hidden p-0"
        >
          <SceneCanvasLoadingPlaceholder />
        </FrameosShell>
      )
    }

    return (
      <FrameosShell
        mode="scenes"
        title="Scenes"
        subtitle="No frames"
        tree={<div className="px-3 py-2 text-slate-400">Add a frame before editing scenes.</div>}
      >
        <div className="frameos-muted flex h-[60vh] items-center justify-center text-sm font-medium">
          No frames available.
        </div>
      </FrameosShell>
    )
  }

  return <SceneWorkspaceFrame frameId={firstFrame.id} />
}

export default SceneWorkspace
