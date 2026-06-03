import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import clsx from 'clsx'
import copy from 'copy-to-clipboard'
import {
  ClipboardDocumentIcon,
  CodeBracketIcon,
  CodeBracketSquareIcon,
  Cog6ToothIcon,
  ListBulletIcon,
  PhotoIcon,
  ServerStackIcon,
  SparklesIcon,
  VariableIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { PencilSquareIcon, PlayIcon } from '@heroicons/react/24/solid'
import { useEffect, type DragEvent } from 'react'
import { FrameImage } from '../../components/FrameImage'
import { Tag } from '../../components/Tag'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { FrameScene, FrameType, NodeData } from '../../types'
import { FrameosShell } from './FrameosShell'
import { FrameDeployPlanDrawer } from './FrameDeployPlanDrawer'
import { FrameSceneSidebarCard } from './FrameSceneSidebarCard'
import { FrameSidebarPreview } from './FrameSidebarPreview'
import { FrameMetricAlertIndicator } from './FrameMetricAlertIndicator'
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
import { RenameSceneModal } from '../frame/panels/Scenes/RenameSceneModal'
import { SceneSettings } from '../frame/panels/Scenes/SceneSettings'
import { scenesLogic } from '../frame/panels/Scenes/scenesLogic'
import { EditTemplateModal } from '../frame/panels/Templates/EditTemplateModal'
import { ExpandedScene } from '../frame/panels/Scenes/ExpandedScene'
import { SceneDropDown } from '../frame/panels/Scenes/SceneDropDown'
import { getFrameosSceneDragData, hasFrameosSceneDragData, setFrameosSceneDragData } from './sceneDrag'
import { groupFramesByStatus } from './frameStatusGroups'
import { FrameActionsMenu } from './FrameActionsMenu'

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
  { panel: 'state', label: 'Preview', icon: <PlayIcon className="h-5 w-5" /> },
  { panel: 'stateVariables', label: 'State variables', icon: <VariableIcon className="h-5 w-5" /> },
  { panel: 'apps', label: 'Apps', icon: <CodeBracketSquareIcon className="h-5 w-5" /> },
  { panel: 'events', label: 'Events', icon: <ListBulletIcon className="h-5 w-5" /> },
  { panel: 'source', label: 'Source', icon: <CodeBracketIcon className="h-5 w-5" /> },
  { panel: 'json', label: 'JSON', icon: <ServerStackIcon className="h-5 w-5" /> },
  { panel: 'info', label: 'Scene settings', icon: <Cog6ToothIcon className="h-5 w-5" /> },
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
          mediaClassName="@xs:h-full @xs:min-h-[8.625rem]"
        />
        <div className="order-1 min-w-0 space-y-2 @xs:order-2">
          <div>
            <label className="frameos-muted mb-2 block text-xs font-semibold uppercase tracking-wide">Frame</label>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <select
                  value={frame.id}
                  onChange={(event) => navigateToSceneFrame(parseInt(event.target.value, 10))}
                  className="frameos-form-control min-w-0 w-full rounded-xl border border-slate-200 bg-white py-2 pl-3 pr-9 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-400"
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
                <FrameMetricAlertIndicator
                  frame={frame}
                  className="pointer-events-none absolute right-7 top-1/2 -translate-y-1/2"
                />
              </div>
              <FrameActionsMenu
                frame={frame}
                className="frameos-form-control flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white !px-0 !py-0 text-slate-700 shadow-none transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              />
            </div>
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
              const unsaved = unsavedSceneIds.has(scene.id)
              const undeployed = undeployedSceneIds.has(scene.id)
              const changeStatusLabel = unsaved ? 'Unsaved changes' : undeployed ? 'Undeployed changes' : null
              const sceneStatusTitle = [active ? 'Active scene' : 'Inactive scene', changeStatusLabel]
                .filter(Boolean)
                .join(' · ')
              const compiled = sceneIsCompiled(scene)

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
                    title={sceneStatusTitle || undefined}
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
                        title={active ? 'Active scene' : 'Inactive scene'}
                        aria-label={active ? 'Active scene' : 'Inactive scene'}
                        className={clsx(
                          'absolute bottom-1 right-1 h-2.5 w-2.5 rounded-full shadow-sm ring-2',
                          active ? 'bg-emerald-500 ring-white' : 'bg-white ring-slate-300/80'
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="frameos-strong block truncate text-sm font-semibold text-slate-700">
                        {scene.name || 'Untitled scene'}
                      </span>
                      <span className="frameos-muted mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-slate-400">
                        <span className="truncate">{scene.nodes?.length ?? 0} nodes</span>
                        {compiled ? (
                          <Tag color="none" className="shrink-0 px-1.5 py-0 text-[10px] font-semibold normal-case">
                            compiled
                          </Tag>
                        ) : null}
                        {active ? (
                          <Tag
                            color="teal"
                            title="Active scene"
                            className="shrink-0 px-1.5 py-0 text-[10px] font-semibold normal-case"
                          >
                            active
                          </Tag>
                        ) : null}
                        {changeStatusLabel ? (
                          <Tag
                            color="yellow"
                            title={changeStatusLabel}
                            className="shrink-0 px-1.5 py-0 text-[10px] font-semibold normal-case"
                          >
                            {unsaved ? 'unsaved' : 'undeployed'}
                          </Tag>
                        ) : null}
                      </span>
                    </span>
                  </button>
                  <div className="pr-1">
                    <SceneDropDown context="scenes" sceneId={scene.id} navigation="workspace" />
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
  selectedSceneId,
  unsavedChanges,
  undeployedChanges,
}: {
  frame: FrameType
  frames: FrameType[]
  scenes: FrameScene[]
  selectedSceneId: string | null
  unsavedChanges: boolean
  undeployedChanges: boolean
}): JSX.Element {
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
      {nodeTreeItems.map((item, index) => (
        <SceneNodeTreeButton
          key={item.node.id}
          item={item}
          itemIndex={index}
          items={nodeTreeItems}
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
  itemIndex,
  items,
  highlighted,
  onClick,
}: {
  item: DiagramNodeTreeItem
  itemIndex: number
  items: DiagramNodeTreeItem[]
  highlighted: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'relative flex w-full items-center gap-2 rounded-xl py-1.5 pr-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        highlighted ? 'frameos-primary-active' : 'frameos-strong hover:bg-white/55',
        item.kind === 'disconnected' && !highlighted && 'opacity-70'
      )}
      style={{ paddingLeft: `${12 + item.depth * 14}px` }}
    >
      <SceneNodeTreeConnectors item={item} itemIndex={itemIndex} items={items} highlighted={highlighted} />
      {item.depth > 0 ? <span className="h-px w-3 shrink-0 opacity-0" /> : null}
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

function SceneNodeTreeConnectors({
  item,
  itemIndex,
  items,
  highlighted,
}: {
  item: DiagramNodeTreeItem
  itemIndex: number
  items: DiagramNodeTreeItem[]
  highlighted: boolean
}): JSX.Element | null {
  if (item.depth <= 0) {
    return null
  }

  const previousDepth = itemIndex > 0 ? items[itemIndex - 1].depth : -1
  const nextDepth = itemIndex < items.length - 1 ? items[itemIndex + 1].depth : -1
  const lineClassName = clsx(
    'scene-node-tree-line',
    highlighted ? 'scene-node-tree-line-highlighted bg-white/45' : 'frameos-divider bg-slate-300'
  )

  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0">
      {Array.from({ length: item.depth }, (_, offset) => {
        const depth = offset + 1
        const left = 12 + depth * 14
        const isCurrentDepth = depth === item.depth
        const hasTopSegment = isCurrentDepth || previousDepth >= depth || previousDepth === depth - 1
        const hasBottomSegment = nextDepth >= depth

        if (!hasTopSegment && !hasBottomSegment && !isCurrentDepth) {
          return null
        }

        return (
          <span key={depth}>
            {hasTopSegment ? (
              <span
                className={clsx('scene-node-tree-line-vertical absolute top-0 h-1/2 w-px', lineClassName)}
                style={{ left }}
              />
            ) : null}
            {hasBottomSegment ? (
              <span
                className={clsx('scene-node-tree-line-vertical absolute bottom-0 h-1/2 w-px', lineClassName)}
                style={{ left }}
              />
            ) : null}
            {isCurrentDepth ? (
              <span
                className={clsx('scene-node-tree-line-horizontal absolute top-1/2 h-px w-3', lineClassName)}
                style={{ left }}
              />
            ) : null}
          </span>
        )
      })}
    </span>
  )
}

function UtilityToolbar({ scene }: { scene: FrameScene | null }): JSX.Element {
  const { chatDrawerSelection, utilityPanel } = useValues(workspaceLogic)
  const { closeChatDrawer, closeUtilityPanel, openUtilityPanel } = useActions(workspaceLogic)
  const utilityPanelIsVisible = !chatDrawerSelection
  const definitions = sceneUtilityDefinitions(scene)

  return (
    <div className="scene-diagram-utility-toolbar pointer-events-none flex shrink-0 flex-col items-center gap-2">
      {definitions.map((definition) => (
        <button
          key={definition.panel}
          type="button"
          title={definition.label}
          onClick={() => {
            if (utilityPanelIsVisible && utilityPanel === definition.panel) {
              closeUtilityPanel()
              return
            }
            closeChatDrawer()
            openUtilityPanel(definition.panel)
          }}
          className={clsx(
            'frameos-icon-button pointer-events-auto flex h-10 w-10 items-center justify-center rounded-xl border border-white/90 bg-white/90 text-slate-500 shadow-lg shadow-slate-300/25 backdrop-blur-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            utilityPanelIsVisible && utilityPanel === definition.panel
              ? 'frameos-primary-active text-white'
              : 'bg-white/90 text-slate-500'
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
  const { closeChatDrawer, closeUtilityPanel, openChatDrawer } = useActions(workspaceLogic)
  const chatDrawerIsOpen = chatDrawerSelection?.frameId === frameId && chatDrawerSelection.sceneId === sceneId

  return (
    <div className="scene-diagram-overlay pointer-events-none absolute inset-0 z-20">
      <div className="scene-diagram-corner-toolbar pointer-events-none absolute flex min-w-0 items-start gap-2">
        <div className="scene-diagram-node-toolbar scene-diagram-utility-toolbar pointer-events-none flex min-w-0 flex-wrap items-center justify-end gap-2">
          {sceneId ? <DiagramToolbar sceneId={sceneId} showSceneAction={false} variant="floating" /> : null}
        </div>
        <div className="scene-diagram-utility-buttons scene-diagram-utility-toolbar pointer-events-none flex shrink-0 flex-col items-center gap-2">
          <button
            type="button"
            title="Open AI chat"
            onClick={() => {
              if (chatDrawerIsOpen) {
                closeChatDrawer()
                return
              }
              closeUtilityPanel()
              openChatDrawer(frameId, sceneId)
            }}
            className={clsx(
              'frameos-icon-button pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/90 bg-white/90 text-slate-500 shadow-lg shadow-slate-300/25 backdrop-blur-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              chatDrawerIsOpen ? 'frameos-primary-active text-white' : 'bg-white/90 text-slate-500'
            )}
          >
            <SparklesIcon className="h-5 w-5" />
          </button>
          <UtilityToolbar scene={scene} />
        </div>
      </div>
    </div>
  )
}

function SceneTreeLoadingPlaceholder(): JSX.Element {
  return (
    <div className="space-y-4">
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
        <div className="mt-3 grid grid-cols-2 gap-2">
          {[0, 1].map((index) => (
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
    </div>
  )
}

function SceneCanvasLoadingPlaceholder(): JSX.Element {
  return (
    <div className="scene-editor-canvas scene-editor-canvas-full h-screen min-h-screen overflow-hidden p-5">
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

function SceneInfoPanel({ frameId, scene }: { frameId: number; scene: FrameScene }): JSX.Element {
  const { renameScene } = useActions(scenesLogic({ frameId }))
  const nodes = scene.nodes ?? []
  const edges = scene.edges ?? []
  const sceneApps = scene.apps ?? {}
  const connectedNodeIds = new Set<string>()
  edges.forEach((edge) => {
    if (edge.source) {
      connectedNodeIds.add(edge.source)
    }
    if (edge.target) {
      connectedNodeIds.add(edge.target)
    }
  })
  const disconnectedNodes = nodes.filter((node) => !connectedNodeIds.has(node.id)).length
  const stats = [
    { label: 'Nodes', value: nodes.length },
    { label: 'Edges', value: edges.length },
    { label: 'Scene apps', value: Object.keys(sceneApps).length },
    { label: 'Fields', value: scene.fields?.length ?? 0 },
    { label: 'Disconnected', value: disconnectedNodes },
  ]

  return (
    <div className="frame-tool-panel space-y-5 @container">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="frameos-strong truncate text-lg font-bold">{scene.name || 'Untitled scene'}</div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <div className="frameos-muted truncate font-mono text-xs text-slate-400">{scene.id}</div>
            <button
              type="button"
              title="Copy scene id"
              onClick={() => copy(scene.id)}
              className="frameos-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <ClipboardDocumentIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => renameScene(scene.id)}
          className="frameos-secondary-button inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <PencilSquareIcon className="h-4 w-4" />
          <span>Rename</span>
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="frame-tool-row rounded-xl px-3 py-2">
            <div className="frame-tool-muted text-[11px] font-semibold uppercase tracking-wide">{stat.label}</div>
            <div className="frameos-strong mt-0.5 truncate text-sm font-semibold">{stat.value}</div>
          </div>
        ))}
      </div>
      <SceneSettings sceneId={scene.id} embedded />
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-500">Nodes</div>
          <span className="frameos-muted rounded-full bg-slate-500/10 px-2 py-0.5 text-[11px] font-semibold">
            {nodes.length}
          </span>
        </div>
        <SceneNodesList frameId={frameId} scene={scene} />
      </div>
    </div>
  )
}

function UtilityDrawer({ frameId, scene }: { frameId: number; scene: FrameScene | null }): JSX.Element | null {
  const { utilityPanel } = useValues(workspaceLogic)
  const { closeUtilityPanel } = useActions(workspaceLogic)
  const activeDefinition = sceneUtilityDefinition(utilityPanel, scene)
  const drawerContextLabel = scene?.name || 'Untitled scene'

  if (!utilityPanel || !activeDefinition) {
    return null
  }

  const renderPanel = () => {
    if (utilityPanel === 'info') {
      return scene ? <SceneInfoPanel frameId={frameId} scene={scene} /> : <div>Select a scene first.</div>
    }
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
            <div className="frameos-muted truncate text-xs font-semibold text-slate-500" title={drawerContextLabel}>
              {drawerContextLabel}
            </div>
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
      <SceneSelectedNodeSync frameId={frameId} sceneId={selectedSceneId} />
      <Diagram sceneId={selectedSceneId} showToolbar={false} />
      <SceneDiagramOverlay frameId={frameId} scene={selectedScene} sceneId={selectedSceneId} />
    </div>
  )
}

function SceneSelectedNodeSync({ frameId, sceneId }: { frameId: number; sceneId: string }): null {
  const { selectedNodeId } = useValues(workspaceLogic)
  const diagram = diagramLogic({ frameId, sceneId })
  const { nodes } = useValues(diagram)
  const { selectNode } = useActions(diagram)

  useEffect(() => {
    if (!selectedNodeId) {
      return
    }
    const target = nodes.find((node) => node.id === selectedNodeId)
    if (!target) {
      return
    }
    const onlyTargetSelected = target.selected && nodes.every((node) => node.id === selectedNodeId || !node.selected)
    if (!onlyTargetSelected) {
      selectNode(selectedNodeId)
    }
  }, [nodes, selectNode, selectedNodeId])

  return null
}

function SceneWorkspaceFrame({ frameId }: SceneWorkspaceFrameProps): JSX.Element {
  const frameLogicProps = { frameId }
  const { frame, scenes, unsavedChanges, undeployedChanges, deployPlanModalOpen } = useValues(
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
  const activeUtilityDefinition = sceneUtilityDefinition(utilityPanel, selectedScene)

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      <BindLogic logic={panelsLogic} props={frameLogicProps}>
        <FrameosShell
          mode="scenes"
          title="Scenes"
          browserTitle={frame.name || frameHost(frame)}
          tree={
            <SceneTree
              frame={frame}
              frames={framesList}
              scenes={scenes}
              selectedSceneId={resolvedSceneId}
              unsavedChanges={unsavedChanges}
              undeployedChanges={undeployedChanges}
            />
          }
          topBar={null}
          showAiButton={false}
          mainClassName="scene-workspace-main h-screen overflow-hidden p-0"
          rightPanel={
            deployPlanModalOpen ? (
              <FrameDeployPlanDrawer frame={frame} />
            ) : activeUtilityDefinition ? (
              <UtilityDrawer frameId={frameId} scene={selectedScene} />
            ) : null
          }
        >
          <SceneCanvas frameId={frame.id} selectedScene={selectedScene} selectedSceneId={resolvedSceneId} />
        </FrameosShell>
        <EditTemplateModal />
        <RenameSceneModal frameId={frameId} />
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
