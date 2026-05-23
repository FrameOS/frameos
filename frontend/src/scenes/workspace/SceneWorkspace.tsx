import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import clsx from 'clsx'
import {
  CalendarDaysIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeBracketIcon,
  CubeTransparentIcon,
  EyeIcon,
  ListBulletIcon,
  PhotoIcon,
  ServerStackIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import type { DragEvent } from 'react'
import { FrameImage } from '../../components/FrameImage'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { FrameScene, FrameType, NodeData } from '../../types'
import { FrameosShell } from './FrameosShell'
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
import { Schedule } from '../frame/panels/Schedule/Schedule'
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
  { panel: 'schedule', label: 'Schedule', icon: <CalendarDaysIcon className="h-5 w-5" /> },
  { panel: 'apps', label: 'Apps', icon: <CubeTransparentIcon className="h-5 w-5" /> },
  { panel: 'events', label: 'Events', icon: <ListBulletIcon className="h-5 w-5" /> },
  { panel: 'source', label: 'Source', icon: <CodeBracketIcon className="h-5 w-5" /> },
  { panel: 'json', label: 'JSON', icon: <ServerStackIcon className="h-5 w-5" /> },
]

function sceneUtilityDefinition(panel: WorkspaceUtilityPanel | null): UtilityDefinition | null {
  return utilityDefinitions.find((definition) => definition.panel === panel) ?? null
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
}: {
  frame: FrameType
  frames: FrameType[]
  scenes: FrameScene[]
  selectedSceneId: string | null
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
    <div className="space-y-3 px-2">
      <div>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">Frame</label>
        <select
          value={frame.id}
          onChange={(event) => navigateToSceneFrame(parseInt(event.target.value, 10))}
          className="frameos-form-control min-h-12 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-400"
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
      <div onDragOver={handleSceneListDragOver} onDrop={handleSceneListDrop}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Scenes</label>
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
                          active ? 'bg-[#4a4b8c]' : changed ? 'bg-amber-400' : 'bg-slate-300'
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
  const { openUtilityPanel, toggleSceneNodesOpen } = useActions(workspaceLogic)
  const { saveFrame, saveAndDeployFrame } = useActions(frameLogic({ frameId: frame.id }))
  const { linkedActiveSceneId } = useValues(scenesLogic({ frameId: frame.id }))
  const sceneNodes = selectedScene?.nodes ?? []
  const execution = selectedScene?.settings?.execution === 'interpreted' ? 'Interpreted' : 'Compiled'
  const selectedSceneIsActive = selectedSceneId !== null && linkedActiveSceneId === selectedSceneId

  return (
    <div className="space-y-4">
      <SceneSelector frame={frame} frames={frames} scenes={scenes} selectedSceneId={selectedSceneId} />
      <div className="frameos-inset mx-2 rounded-2xl border border-slate-200 bg-white/55 p-3">
        <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
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
              unsavedChanges ? 'frameos-primary-action text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
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
        <div className="frameos-card mx-2 overflow-hidden rounded-2xl border border-white/80 bg-white/65 shadow-sm">
          <div className="frameos-card-media relative h-32 bg-slate-100">
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
        highlighted ? 'bg-slate-900 text-white' : 'frameos-strong text-slate-700 hover:bg-slate-100',
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
          className={clsx('block truncate text-xs', highlighted ? 'text-slate-300' : 'frameos-muted text-slate-400')}
        >
          {nodeKindLabel(item)}
        </span>
      </span>
    </button>
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

function SceneEditorTopBarLoadingPlaceholder(): JSX.Element {
  return (
    <div className="mb-4 flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="frameos-skeleton-surface h-10 w-10 animate-pulse rounded-full" />
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="frameos-skeleton-surface h-11 w-11 animate-pulse rounded-full" />
        ))}
      </div>
    </div>
  )
}

function SceneTreeLoadingPlaceholder(): JSX.Element {
  return (
    <div className="space-y-4 px-2">
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Frame</div>
        <div className="frameos-skeleton-surface h-12 animate-pulse rounded-xl" />
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Scenes</div>
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
      <div className="frameos-skeleton-surface mx-2 h-32 overflow-hidden rounded-2xl">
        <div className="frameos-skeleton-media h-full animate-pulse" />
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
    <div className="scene-editor-canvas h-[calc(100vh-5.25rem)] min-h-[34rem] overflow-hidden rounded-[24px] border border-white/80 bg-white/35 p-5 shadow-lg shadow-slate-300/20">
      <div className="relative h-full overflow-hidden rounded-[20px]">
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

function UtilityDrawer({ frameId, scene }: { frameId: number; scene: FrameScene | null }): JSX.Element | null {
  const { utilityPanel } = useValues(workspaceLogic)
  const { closeUtilityPanel, openUtilityPanel } = useActions(workspaceLogic)
  const activeDefinition = sceneUtilityDefinition(utilityPanel)

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
    if (utilityPanel === 'schedule') return <Schedule scrollContainer={false} drawerMode />
    if (utilityPanel === 'source') return <SceneSource />
    if (utilityPanel === 'json') return scene ? <SceneJSON sceneId={scene.id} /> : <div>Select a scene first.</div>
    return null
  }

  return (
    <div className="frameos-drawer fixed bottom-5 right-5 top-5 z-40 flex w-[430px] max-w-[calc(100vw-40px)] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 text-slate-900 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <div className="frameos-divider flex w-[72px] shrink-0 flex-col items-center gap-2 border-r border-slate-200/80 py-4">
        {utilityDefinitions.map((definition) => (
          <button
            key={definition.panel}
            type="button"
            title={definition.label}
            onClick={() => openUtilityPanel(definition.panel)}
            className={clsx(
              'frameos-icon-button flex h-11 w-11 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              utilityPanel === definition.panel
                ? 'frameos-primary-active text-white'
                : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
            )}
          >
            {definition.icon}
          </button>
        ))}
      </div>
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
            className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
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
  const { openUtilityPanel, navigateToScene } = useActions(workspaceLogic)

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
        className="flex h-[calc(100vh-6rem)] items-center justify-center rounded-[24px] border border-white/80 bg-white/55 text-slate-500 shadow-lg shadow-slate-300/25"
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
      className="scene-editor-canvas h-[calc(100vh-5.25rem)] min-h-[34rem] overflow-hidden"
      onDragOverCapture={handleSceneDragOver}
      onDropCapture={handleSceneDrop}
    >
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
  const { selectedSceneId, utilityPanel } = useValues(workspaceLogic)
  const activeUtilityDefinition = sceneUtilityDefinition(utilityPanel)

  if (!frame) {
    return (
      <FrameosShell
        mode="scenes"
        title="Scenes"
        tree={<SceneTreeLoadingPlaceholder />}
        topBar={<SceneEditorTopBarLoadingPlaceholder />}
        mainClassName="h-screen overflow-hidden py-5 pl-[456px] pr-5 max-lg:h-auto max-lg:overflow-visible max-lg:px-4"
      >
        <SceneCanvasLoadingPlaceholder />
      </FrameosShell>
    )
  }

  const resolvedSceneId =
    selectedSceneId && scenes.some((scene) => scene.id === selectedSceneId) ? selectedSceneId : scenes[0]?.id ?? null
  const selectedScene = scenes.find((scene) => scene.id === resolvedSceneId) ?? null

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
              scenes={scenes}
              selectedScene={selectedScene}
              selectedSceneId={resolvedSceneId}
              unsavedChanges={unsavedChanges}
              undeployedChanges={undeployedChanges}
            />
          }
          topBar={<SceneEditorTopBar sceneId={resolvedSceneId} />}
          mainClassName="h-screen overflow-hidden py-5 pl-[456px] pr-5 max-lg:h-auto max-lg:overflow-visible max-lg:px-4"
          rightPanel={activeUtilityDefinition ? <UtilityDrawer frameId={frameId} scene={selectedScene} /> : null}
        >
          <SceneCanvas frameId={frame.id} selectedSceneId={resolvedSceneId} />
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
          topBar={<SceneEditorTopBarLoadingPlaceholder />}
          mainClassName="h-screen overflow-hidden py-5 pl-[456px] pr-5 max-lg:h-auto max-lg:overflow-visible max-lg:px-4"
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
        <div className="flex h-[60vh] items-center justify-center rounded-[24px] border border-white/80 bg-white/55 text-slate-500 shadow-lg shadow-slate-300/25">
          No frames available.
        </div>
      </FrameosShell>
    )
  }

  return <SceneWorkspaceFrame frameId={firstFrame.id} />
}

export default SceneWorkspace
