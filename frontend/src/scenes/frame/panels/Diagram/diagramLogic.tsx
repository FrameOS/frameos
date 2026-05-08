import {
  actions,
  afterMount,
  beforeUnmount,
  connect,
  kea,
  key,
  listeners,
  path,
  props,
  reducers,
  selectors,
  sharedListeners,
} from 'kea'
import { framesModel } from '../../../../models/framesModel'
import { applyEdgeChanges, applyNodeChanges, addEdge } from 'reactflow'
import { v4 as uuidv4 } from 'uuid'

import type { XYPosition } from '@reactflow/core/dist/esm/types/utils'
import type { Node } from '@reactflow/core/dist/esm/types/nodes'
import type { Edge } from '@reactflow/core/dist/esm/types/edges'
import type { Connection } from '@reactflow/core/dist/esm/types/general'
import type { EdgeChange, NodeChange } from '@reactflow/core/dist/esm/types/changes'
import equal from 'fast-deep-equal'
import type { diagramLogicType } from './diagramLogicType'
import { subscriptions } from 'kea-subscriptions'
import {
  AppConfig,
  AppConfigField,
  AppNodeData,
  CodeNodeData,
  DiagramNode,
  DispatchNodeData,
  EventNodeData,
  FrameEvent,
  FrameScene,
  FrameSceneSettings,
  MarkdownField,
  SceneApp,
  StateNodeData,
} from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'
import { arrangeNodes } from '../../../../utils/arrangeNodes'
import copy from 'copy-to-clipboard'
import { Option } from '../../../../components/Select'
import _events from '../../../../../schema/events.json'
import {
  installSceneAppForKeyword,
  mergeSceneAndCatalogApps,
  nextSceneAppKey,
  normalizeSceneApps,
  sceneAppToAppConfig,
  sceneAppWithOrigin,
  updateSceneAppsInScenes,
} from '../../../../utils/sceneApps'

const events = _events as FrameEvent[]

function fieldOrderFromFields(fields?: (AppConfigField | MarkdownField)[] | null): string[] {
  return (fields ?? []).filter((field): field is AppConfigField => 'name' in field).map((field) => field.name)
}

export interface DiagramLogicProps {
  frameId: number
  sceneId: string
  updateNodeInternals?: (nodeId: string) => void
}

export interface NewNodePicker {
  screenX: number
  screenY: number
  diagramX: number
  diagramY: number
  handleId: string
  handleType: string
  nodeId: string
}

export type CodeNodeLanguage = 'js' | 'nim'

export type DiagramHistorySnapshot = {
  nodes: DiagramNode[]
  edges: Edge[]
  apps: Record<string, SceneApp>
}

export type DiagramHistoryState = {
  past: DiagramHistorySnapshot[]
  future: DiagramHistorySnapshot[]
}

type ClipboardDiagramPayload = {
  nodes: DiagramNode[]
  edges: Edge[]
  apps?: Record<string, SceneApp>
}

const MAX_HISTORY_LENGTH = 100
const HISTORY_DEBOUNCE_MS = 300
const DELETE_HISTORY_DEBOUNCE_MS = 50

const normalizeNodes = (nodes: DiagramNode[]): DiagramNode[] =>
  nodes.map((node) => {
    const { selected, dragging, positionAbsolute, dragHandle, resizing, width, height, ...rest } =
      node as DiagramNode & {
        dragging?: boolean
        positionAbsolute?: XYPosition
        dragHandle?: string
        resizing?: boolean
      }
    if (node.type === 'code' && typeof width !== 'undefined' && typeof height !== 'undefined') {
      return { ...rest, width, height } as DiagramNode
    }
    return rest as DiagramNode
  })

const normalizeEdges = (edges: Edge[]): Edge[] =>
  edges.map((edge) => {
    const { selected, ...rest } = edge
    return rest as Edge
  })

const deselectNodes = (nodes: DiagramNode[]): DiagramNode[] =>
  nodes.map((node) => (node.selected ? { ...node, selected: false } : node))

const makeHistorySnapshot = (
  nodes: DiagramNode[],
  edges: Edge[],
  apps: Record<string, SceneApp> = {}
): DiagramHistorySnapshot => ({
  nodes: normalizeNodes(nodes),
  edges: normalizeEdges(edges),
  apps,
})

const sortById = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => a.id.localeCompare(b.id))

const comparableHistorySnapshot = (snapshot: DiagramHistorySnapshot): DiagramHistorySnapshot => ({
  nodes: sortById(normalizeNodes(snapshot.nodes)),
  edges: sortById(
    normalizeEdges(snapshot.edges).map((edge) => {
      const { type, ...rest } = edge
      return rest as Edge
    })
  ),
  apps: snapshot.apps,
})

const historySnapshotsEqual = (
  first: DiagramHistorySnapshot | null | undefined,
  second: DiagramHistorySnapshot | null | undefined
): boolean => {
  if (!first || !second) {
    return first === second
  }
  return equal(comparableHistorySnapshot(first), comparableHistorySnapshot(second))
}

const scheduleHistorySnapshot = (
  cache: Record<string, any>,
  actions: { recordHistory: (snapshot: DiagramHistorySnapshot) => void },
  snapshot: DiagramHistorySnapshot,
  delayMs: number = HISTORY_DEBOUNCE_MS
): void => {
  if (cache.historyTimer) {
    window.clearTimeout(cache.historyTimer)
  }
  cache.pendingHistorySnapshot = snapshot
  cache.historyTimer = window.setTimeout(() => {
    cache.historyTimer = null
    const pendingSnapshot = cache.pendingHistorySnapshot
    cache.pendingHistorySnapshot = null
    actions.recordHistory(pendingSnapshot ?? snapshot)
  }, delayMs)
}

const flushHistorySnapshot = (
  cache: Record<string, any>,
  actions: { recordHistory: (snapshot: DiagramHistorySnapshot) => void }
): void => {
  if (!cache.historyTimer) {
    return
  }
  window.clearTimeout(cache.historyTimer)
  cache.historyTimer = null
  const pendingSnapshot = cache.pendingHistorySnapshot
  cache.pendingHistorySnapshot = null
  if (pendingSnapshot) {
    actions.recordHistory(pendingSnapshot)
  }
}

const recordHistorySnapshot = (
  cache: Record<string, any>,
  actions: { recordHistory: (snapshot: DiagramHistorySnapshot) => void },
  snapshot: DiagramHistorySnapshot
): void => {
  flushHistorySnapshot(cache, actions)
  actions.recordHistory(snapshot)
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.closest('[data-editable="true"]')) {
    return true
  }
  if (target.isContentEditable) {
    return true
  }
  if (target.closest('[contenteditable="true"]')) {
    return true
  }
  if (target.closest('.monaco-editor, .monaco-editor *')) {
    return true
  }
  if (target.getAttribute('role') === 'textbox' || target.closest('[role="textbox"]')) {
    return true
  }
  const tagName = target.tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

const hasTextSelection = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return false
  }
  return !selection.isCollapsed && selection.toString().length > 0
}

const sanitizeClipboardNode = (node: DiagramNode): DiagramNode => {
  const { selected, dragging, positionAbsolute, ...rest } = node as DiagramNode & {
    dragging?: boolean
    positionAbsolute?: XYPosition
  }
  return rest as DiagramNode
}

const getNodeAppKeyword = (node: DiagramNode): string | null => {
  if (node.type !== 'app') {
    return null
  }
  const keyword = (node.data as AppNodeData | undefined)?.keyword
  return typeof keyword === 'string' && keyword ? keyword : null
}

const collectSceneAppsForNodes = (
  nodes: DiagramNode[],
  sceneApps: Record<string, SceneApp>
): Record<string, SceneApp> => {
  const apps: Record<string, SceneApp> = {}
  for (const node of nodes) {
    const keyword = getNodeAppKeyword(node)
    if (keyword && sceneApps[keyword]) {
      apps[keyword] = sceneAppWithOrigin(sceneApps[keyword], keyword)
    }
  }
  return apps
}

const clipboardPayloadForNodes = (
  nodes: DiagramNode[],
  edges: Edge[],
  sceneApps: Record<string, SceneApp>
): DiagramNode | ClipboardDiagramPayload => {
  const sanitizedNodes = nodes.map(sanitizeClipboardNode)
  const apps = collectSceneAppsForNodes(sanitizedNodes, sceneApps)
  if (sanitizedNodes.length === 1 && edges.length === 0 && Object.keys(apps).length === 0) {
    return sanitizedNodes[0]
  }
  return {
    nodes: sanitizedNodes,
    edges,
    ...(Object.keys(apps).length > 0 ? { apps } : {}),
  }
}

const parseClipboardPayload = (parsed: unknown): ClipboardDiagramPayload | null => {
  if (!parsed) {
    return null
  }
  if (Array.isArray(parsed)) {
    return { nodes: parsed as DiagramNode[], edges: [] }
  }
  if (typeof parsed === 'object') {
    const payload = parsed as { nodes?: DiagramNode[]; edges?: Edge[]; apps?: Record<string, SceneApp> }
    if (Array.isArray(payload.nodes)) {
      return { nodes: payload.nodes, edges: payload.edges ?? [], apps: payload.apps ?? {} }
    }
    if ('type' in (parsed as DiagramNode)) {
      return { nodes: [parsed as DiagramNode], edges: [] }
    }
  }
  return null
}

const mergePastedSceneApps = (
  nodes: DiagramNode[],
  sceneApps: Record<string, SceneApp>,
  pastedApps: Record<string, SceneApp> = {}
): { sceneApps: Record<string, SceneApp>; keywordMap: Map<string, string> } => {
  const nextSceneApps = { ...sceneApps }
  const keywordMap = new Map<string, string>()

  for (const node of nodes) {
    const keyword = getNodeAppKeyword(node)
    if (!keyword || keywordMap.has(keyword) || !pastedApps[keyword]) {
      continue
    }

    const pastedApp = sceneAppWithOrigin(pastedApps[keyword], keyword)
    if (!nextSceneApps[keyword]) {
      nextSceneApps[keyword] = pastedApp
      keywordMap.set(keyword, keyword)
      continue
    }

    if (equal(nextSceneApps[keyword], pastedApp)) {
      keywordMap.set(keyword, keyword)
      continue
    }

    const newKeyword = nextSceneAppKey(nextSceneApps, keyword, sceneAppToAppConfig(pastedApp))
    nextSceneApps[newKeyword] = pastedApp
    keywordMap.set(keyword, newKeyword)
  }

  return { sceneApps: nextSceneApps, keywordMap }
}

const getClipboardOffset = (nodes: DiagramNode[], basePosition?: XYPosition | null): XYPosition => {
  if (nodes.length === 0) {
    return { x: 0, y: 0 }
  }
  const minX = Math.min(...nodes.map((node) => node.position?.x ?? 0))
  const minY = Math.min(...nodes.map((node) => node.position?.y ?? 0))
  const fallback = { x: minX + 40, y: minY + 40 }
  const anchor = basePosition ?? fallback
  return { x: anchor.x - minX, y: anchor.y - minY }
}

const duplicateDiagramNode = (node: DiagramNode): DiagramNode => {
  return {
    ...sanitizeClipboardNode(node),
    id: uuidv4(),
    position: { x: (node.position?.x ?? 0) + 40, y: (node.position?.y ?? 0) + 40 },
    data: JSON.parse(JSON.stringify(node.data ?? {})),
    selected: true,
  }
}

const removeAutoArrangeMarker = (settings?: FrameSceneSettings): FrameSceneSettings | undefined => {
  if (!settings?.autoArrangeOnLoad) {
    return settings
  }
  const { autoArrangeOnLoad: _, ...rest } = settings
  return Object.keys(rest).length > 0 ? rest : undefined
}

export const diagramLogic = kea<diagramLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Diagram', 'diagramLogic']),
  props({} as DiagramLogicProps),
  key((props) => `${props.frameId}/${props.sceneId}`),
  connect(({ frameId }: DiagramLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm'], appsModel, ['apps']],
    actions: [frameLogic({ frameId }), ['setFrameFormValues', 'applyTemplate']],
  })),
  actions({
    setNodes: (nodes: DiagramNode[]) => ({ nodes }),
    setEdges: (edges: Edge[]) => ({ edges }),
    addEdge: (edge: Edge | Connection) => ({ edge }),
    onNodesChange: (changes: NodeChange[]) => ({ changes }),
    onEdgesChange: (changes: EdgeChange[]) => ({ changes }),
    selectNode: (nodeId: string) => ({ nodeId }),
    deselectNode: true,
    rearrangeCurrentScene: true,
    fitDiagramView: true,
    keywordDropped: (keyword: string, type: string, position: XYPosition) => ({ keyword, type, position }),
    setSceneApps: (apps: Record<string, SceneApp>, forceCompiled: boolean = false) => ({ apps, forceCompiled }),
    forkSceneApp: (nodeId: string) => ({ nodeId }),
    updateNodeData: (id: string, data: Record<string, any>) => ({ id, data }),
    updateEdge: (edge: Edge) => ({ edge }),
    updateNodeConfig: (id: string, field: string, value: any) => ({ id, field, value }),
    copyAppJSON: (nodeId: string) => ({ nodeId }),
    duplicateNode: (nodeId: string) => ({ nodeId }),
    copySelectedNodes: true,
    pasteFromClipboard: true,
    setCursorPosition: (position: XYPosition | null) => ({ position }),
    deleteApp: (id: string) => ({ id }),
    recordHistory: (snapshot: DiagramHistorySnapshot) => ({ snapshot }),
    resetHistory: (snapshot: DiagramHistorySnapshot) => ({ snapshot }),
    undo: true,
    redo: true,
  }),
  reducers({
    nodes: [
      [] as DiagramNode[],
      {
        setNodes: (_, { nodes }) => nodes,
        onNodesChange: (state, { changes }) => {
          const newNodes = applyNodeChanges(changes, state)
          return equal(state, newNodes) ? state : (newNodes as DiagramNode[])
        },
        selectNode: (state, { nodeId }) => {
          const newNodes = state.map((node) =>
            node.id === nodeId ? { ...node, selected: true } : node.selected ? { ...node, selected: false } : node
          )
          return equal(state, newNodes) ? state : newNodes
        },
        deselectNode: (state) => {
          const newNodes = state.map((node) => ({ ...node, selected: false }))
          return equal(state, newNodes) ? state : newNodes
        },
        updateNodeData: (state, { id, data }) => {
          const newNodes = state.map((node) =>
            node.id === id ? { ...node, data: { ...(node.data ?? {}), ...data } } : node
          )
          return equal(state, newNodes) ? state : newNodes
        },
        updateNodeConfig: (state, { id, field, value }) => {
          const newNodes = state.map((node) =>
            node.id === id
              ? {
                  ...node,
                  data: {
                    ...(node.data ?? {}),
                    config: { ...('config' in node.data ? node.data?.config ?? {} : {}), [field]: value },
                  },
                }
              : node
          )
          return equal(state, newNodes) ? state : newNodes
        },
        deleteApp: (state, { id }) => {
          const newNodes = state.filter((node) => node.id !== id)
          return equal(state, newNodes) ? state : newNodes
        },
      },
    ],
    rawEdges: [
      [] as Edge[],
      {
        setEdges: (_, { edges }) => edges,
        onEdgesChange: (state, { changes }) => {
          const newEdges = applyEdgeChanges(changes, state)
          return equal(state, newEdges) ? state : newEdges
        },
        addEdge: (state, { edge }) => {
          const newEdges = addEdge({ id: uuidv4(), ...edge }, state)
          return equal(state, newEdges) ? state : newEdges
        },
        deleteApp: (state, { id }) => {
          const newEdges = state.filter((edge) => edge.source !== id && edge.target !== id)
          return equal(state, newEdges) ? state : newEdges
        },
        updateEdge: (state, { edge }) => {
          const newEdges = state.map((oldEdge) => (oldEdge.id === edge.id ? { ...oldEdge, ...edge } : oldEdge))
          return equal(state, newEdges) ? state : newEdges
        },
      },
    ],
    fitViewCounter: [0, { fitDiagramView: (state) => state + 1 }],
    history: [
      { past: [], future: [] } as DiagramHistoryState,
      {
        recordHistory: (state, { snapshot }) => {
          const last = state.past[state.past.length - 1]
          if (historySnapshotsEqual(last, snapshot)) {
            return state
          }
          const nextPast = [...state.past, snapshot].slice(-MAX_HISTORY_LENGTH)
          return { past: nextPast, future: [] }
        },
        resetHistory: (_, { snapshot }) => ({ past: [snapshot], future: [] }),
        undo: (state) => {
          if (state.past.length <= 1) {
            return state
          }
          const nextPast = state.past.slice(0, -1)
          const previous = state.past[state.past.length - 1]
          return { past: nextPast, future: [previous, ...state.future] }
        },
        redo: (state) => {
          if (state.future.length === 0) {
            return state
          }
          const [next, ...restFuture] = state.future
          return { past: [...state.past, next], future: restFuture }
        },
      },
    ],
    cursorPosition: [
      null as XYPosition | null,
      {
        setCursorPosition: (_, { position }) => position,
      },
    ],
  }),
  selectors({
    frameId: [() => [(_, props) => props.frameId], (frameId) => frameId],
    sceneId: [() => [(_, props) => props.sceneId], (sceneId) => sceneId],
    originalFrame: [(s) => [framesModel.selectors.frames, s.frameId], (frames, frameId) => frames[frameId] || null],
    editingFrame: [
      (s) => [s.frameForm, s.originalFrame],
      (frameForm, originalFrame) => frameForm || originalFrame || null,
    ],
    scene: [
      (s) => [s.editingFrame, s.sceneId],
      (editingFrame, sceneId) => (editingFrame.scenes ?? []).find((s) => s.id === sceneId) || null,
    ],
    sceneName: [(s) => [s.scene], (scene) => scene?.name || (scene?.id ? `Scene: ${scene.id}` : 'Untitled scene')],
    isCompiledScene: [(s) => [s.scene], (scene): boolean => !!scene && scene.settings?.execution !== 'interpreted'],
    sceneApps: [(s) => [s.scene], (scene): Record<string, SceneApp> => normalizeSceneApps(scene?.apps)],
    effectiveApps: [
      (s) => [s.apps, s.scene],
      (apps, scene): Record<string, AppConfig> => mergeSceneAndCatalogApps(apps, scene),
      { resultEqualityCheck: equal },
    ],
    selectedNode: [(s) => [s.nodes], (nodes): Node | null => nodes.find((node) => node.selected) ?? null],
    selectedNodeId: [(s) => [s.selectedNode], (node) => node?.id ?? null],
    selectedNodeIds: [
      (s) => [s.nodes],
      (nodes): string[] => nodes.filter((node) => node.selected).map((node) => node.id),
    ],
    selectedNodes: [(s) => [s.nodes], (nodes: DiagramNode[]): DiagramNode[] => nodes.filter((node) => node.selected)],
    edges: [
      (s) => [s.rawEdges],
      (rawEdges): Edge[] =>
        rawEdges.map((edge) => {
          const newEdge =
            edge.targetHandle === 'prev' || edge.sourceHandle === 'next'
              ? edge.type !== 'appNodeEdge'
                ? { ...edge, type: 'appNodeEdge' }
                : edge
              : edge.type !== 'codeNodeEdge'
              ? { ...edge, type: 'codeNodeEdge' }
              : edge
          return newEdge
        }),
    ],
    selectedEdge: [(s) => [s.edges], (edges): Edge | null => edges.find((edge) => edge.selected) ?? null],
    selectedEdgeId: [(s) => [s.selectedEdge], (edge) => edge?.id ?? null],
    selectedEdges: [(s) => [s.edges], (edges: Edge[]): Edge[] => edges.filter((edge) => edge.selected)],
    edgesForNode: [
      (s) => [s.edges],
      (edges: Edge[]): Record<string, Edge[]> => {
        return edges.reduce((acc, edge) => {
          acc[edge.source] = [...(acc[edge.source] ?? []), edge]
          acc[edge.target] = [...(acc[edge.target] ?? []), edge]
          return acc
        }, {} as Record<string, Edge[]>)
      },
    ],
    nodesById: [
      (s) => [s.nodes],
      (nodes: DiagramNode[]): Record<string, DiagramNode> => {
        return nodes.reduce((acc, node) => {
          if (acc[node.id]) {
            console.error('Duplicate node id found', node.id)
          }
          acc[node.id] = node
          return acc
        }, {} as Record<string, DiagramNode>)
      },
    ],
    hasChanges: [
      (s) => [s.nodes, s.edges, s.sceneApps, s.sceneId, s.originalFrame],
      (nodes, edges, sceneApps, sceneId, originalFrame) => {
        const scene = originalFrame?.scenes?.find((s) => s.id === sceneId)
        return (
          !equal(
            deselectNodes(nodes),
            scene?.nodes
          ) ||
          !equal(
            edges?.map((e) => (e.selected ? { ...e, selected: false } : e)),
            scene?.edges
          ) ||
          !equal(sceneApps, normalizeSceneApps(scene?.apps))
        )
      },
    ],
    nodesWithStyle: [
      (s) => [s.nodes],
      (nodes: DiagramNode[]): DiagramNode[] => nodes.map((node) => ({ ...node, dragHandle: '.frameos-node-title' })),
    ],
    sceneOptions: [
      (s) => [s.editingFrame],
      (frame): Option[] => [
        { label: '', value: '' },
        ...(frame.scenes ?? []).map((s) => ({ label: s.name || 'Unnamed Scene', value: s.id || '' })),
      ],
      { resultEqualityCheck: equal },
    ],
    codeNodeLanguage: [
      (s) => [s.scene],
      (scene: FrameScene | null): CodeNodeLanguage => (scene?.settings?.execution === 'interpreted' ? 'js' : 'nim'),
    ],
    canUndo: [(s) => [s.history], (history) => history.past.length > 1],
    canRedo: [(s) => [s.history], (history) => history.future.length > 0],
  }),
  sharedListeners(({ selectors, actions, values, props, cache }) => ({
    nodesChanged: (_, __, ___, previousState) => {
      const nodes = values.nodes
      const oldNodes = selectors.nodes(previousState)
      const isDragging = nodes.some((node) => node.dragging)

      const hasDimensions = nodes.length > 0 && nodes.every((node) => node.width && node.height)
      const shouldRearrangeForMissingPosition =
        hasDimensions && nodes.every((node) => node.position.x === -9999 && node.position.y === -9999)
      const shouldRearrangeForMarker = hasDimensions && Boolean(values.scene?.settings?.autoArrangeOnLoad)
      const shouldRearrange = shouldRearrangeForMissingPosition || shouldRearrangeForMarker

      // Upon first render of a new scene, the nodes will have x = -9999, y = -9999, width = undefined, height = undefined
      // Upon second render, the width and height will have been set, but x and y will still be -9999 for all nodes
      // If we detect that case, automatically rearrange the scene.
      if (shouldRearrange && !isDragging && !cache.hasAutoArranged) {
        cache.hasAutoArranged = true
        actions.rearrangeCurrentScene()
      }

      if (shouldRearrangeForMarker && cache.hasAutoArranged) {
        actions.setFrameFormValues({
          scenes: values.editingFrame.scenes?.map((scene) =>
            scene.id === props.sceneId
              ? {
                  ...scene,
                  settings: removeAutoArrangeMarker(scene.settings),
                }
              : scene
          ),
        })
      }

      // Avoid syncing frame form values on every drag tick. We'll persist once dragging stops.
      if (isDragging) {
        return
      }

      // Do not update on first render
      if (typeof oldNodes !== 'undefined' && !equal(nodes, oldNodes)) {
        const currentNodeIds = new Set(nodes.map((node) => node.id))
        const deletedSceneAppKeys = Array.from(
          new Set(
            oldNodes
              .filter((node) => !currentNodeIds.has(node.id))
              .map((node) => (node.type === 'app' ? (node.data as AppNodeData).keyword : null))
              .filter((keyword): keyword is string => !!keyword && !!values.sceneApps[keyword])
          )
        )
        const unusedDeletedSceneAppKeys = deletedSceneAppKeys.filter(
          (keyword) => !nodes.some((node) => node.type === 'app' && (node.data as AppNodeData).keyword === keyword)
        )
        const sceneApps =
          unusedDeletedSceneAppKeys.length > 0
            ? Object.fromEntries(
                Object.entries(values.sceneApps).filter(([keyword]) => !unusedDeletedSceneAppKeys.includes(keyword))
              )
            : values.sceneApps

        actions.setFrameFormValues({
          scenes: values.editingFrame.scenes?.map((scene) => {
            if (scene.id !== props.sceneId) {
              return scene
            }
            const sceneNodes = deselectNodes(nodes)
            const nodesChanged = !equal(scene.nodes, sceneNodes)
            const sceneAppsChanged = !equal(normalizeSceneApps(scene.apps), sceneApps)
            return nodesChanged || sceneAppsChanged
              ? ({
                  ...scene,
                  ...(nodesChanged ? { nodes: sceneNodes } : {}),
                  ...(sceneAppsChanged ? { apps: sceneApps } : {}),
                } satisfies FrameScene)
              : scene
          }),
        })
      }
    },
  })),
  subscriptions(({ actions, values, props }) => ({
    edges: (edges: Edge[], oldEdges: Edge[]) => {
      // Do not update on first render
      if (typeof oldEdges !== 'undefined' && edges && !equal(edges, oldEdges)) {
        actions.setFrameFormValues({
          scenes: values.editingFrame.scenes?.map((scene) =>
            scene.id === props.sceneId && !equal(scene.edges, edges)
              ? // set the edges on the scene's form, and remove the selected flag from all
                { ...scene, edges: edges.map((e) => (e.selected ? { ...e, selected: false } : e)) }
              : scene
          ),
        })
      }
    },
    scene: (scene: FrameScene, oldScene: FrameScene) => {
      if (scene && !equal(scene.nodes, oldScene?.nodes)) {
        // nodes changed on the form, update our local state, but retain the selected flag
        const selectedNodeIds = values.selectedNodeIds
        const newNodes = scene.nodes.map((n) => (selectedNodeIds.includes(n.id) ? { ...n, selected: true } : n))
        if (!equal(newNodes, values.nodes)) {
          actions.setNodes(newNodes)
        }
      }
      if (scene && !equal(scene.edges, oldScene?.edges)) {
        // edges changed on the form, update our local state, but retain the selected flag
        const selectedEdgeId = values.selectedEdgeId
        const newEdges = scene.edges.map((e) => (e.id === selectedEdgeId ? { ...e, selected: true } : e))
        if (!equal(newEdges, values.edges)) {
          actions.setEdges(newEdges)
        }
      }
      if (scene && scene.id !== oldScene?.id) {
        actions.resetHistory(makeHistorySnapshot(scene.nodes ?? [], scene.edges ?? [], normalizeSceneApps(scene.apps)))
      }
    },
  })),
  listeners(({ actions, values, props, cache, sharedListeners }) => ({
    selectNode: sharedListeners.nodesChanged,
    deselectNode: sharedListeners.nodesChanged,
    setNodes: [
      sharedListeners.nodesChanged,
      () => {
        if (cache.ignoreHistory) {
          return
        }
        recordHistorySnapshot(cache, actions, makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps))
      },
    ],
    onNodesChange: [
      sharedListeners.nodesChanged,
      ({ changes }) => {
        if (cache.ignoreHistory) {
          return
        }
        if (changes.length > 0 && changes.every((change) => change.type === 'select')) {
          return
        }
        if (
          changes.length > 0 &&
          changes.every((change) => change.type === 'dimensions' && values.nodesById[change.id]?.type !== 'code')
        ) {
          return
        }
        const snapshot = makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps)
        const isDragging = changes.some((change) => change.type === 'position' && change.dragging)
        const isDeleting = changes.some((change) => change.type === 'remove')
        if (isDragging) {
          scheduleHistorySnapshot(cache, actions, snapshot)
          return
        }
        if (isDeleting) {
          scheduleHistorySnapshot(cache, actions, snapshot, DELETE_HISTORY_DEBOUNCE_MS)
          return
        }
        recordHistorySnapshot(cache, actions, snapshot)
      },
    ],
    updateNodeData: [
      sharedListeners.nodesChanged,
      () => {
        if (cache.ignoreHistory) {
          return
        }
        scheduleHistorySnapshot(cache, actions, makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps))
      },
    ],
    updateNodeConfig: [
      () => {
        if (cache.ignoreHistory) {
          return
        }
        scheduleHistorySnapshot(cache, actions, makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps))
      },
      () => {
        const sceneNodes = deselectNodes(values.nodes)
        actions.setFrameFormValues({
          scenes: values.editingFrame.scenes?.map((scene) =>
            scene.id === props.sceneId && !equal(scene.nodes, sceneNodes)
              ? ({
                  ...scene,
                  nodes: sceneNodes,
                } satisfies FrameScene)
              : scene
          ),
        })
      },
    ],
    deleteApp: [
      sharedListeners.nodesChanged,
      () => {
        if (cache.ignoreHistory) {
          return
        }
        recordHistorySnapshot(cache, actions, makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps))
      },
    ],
    setEdges: () => {
      if (cache.ignoreHistory) {
        return
      }
      recordHistorySnapshot(cache, actions, makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps))
    },
    onEdgesChange: ({ changes }) => {
      if (cache.ignoreHistory) {
        return
      }
      if (changes.length > 0 && changes.every((change) => change.type === 'select')) {
        return
      }
      if (changes.some((change) => change.type === 'remove')) {
        scheduleHistorySnapshot(
          cache,
          actions,
          makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps),
          DELETE_HISTORY_DEBOUNCE_MS
        )
        return
      }
      recordHistorySnapshot(cache, actions, makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps))
    },
    addEdge: () => {
      if (cache.ignoreHistory) {
        return
      }
      recordHistorySnapshot(cache, actions, makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps))
    },
    updateEdge: () => {
      if (cache.ignoreHistory) {
        return
      }
      recordHistorySnapshot(cache, actions, makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps))
    },
    setSceneApps: ({ apps, forceCompiled }) => {
      actions.setFrameFormValues({
        scenes: updateSceneAppsInScenes(values.editingFrame.scenes, props.sceneId, apps, forceCompiled),
      })
    },
    forkSceneApp: ({ nodeId }) => {
      const node = values.nodesById[nodeId]
      if (!node || node.type !== 'app') {
        return
      }
      const keyword = (node.data as AppNodeData).keyword
      const sceneApp = values.sceneApps[keyword]
      if (!sceneApp) {
        return
      }
      const app = values.effectiveApps[keyword] ?? sceneAppToAppConfig(sceneApp)
      const newKeyword = nextSceneAppKey(values.sceneApps, keyword, app)
      const forkName = app.name ? `${app.name} copy` : sceneApp.name
      const sceneAppWithCurrentOrigin = sceneAppWithOrigin(sceneApp, keyword)
      const sources = { ...sceneAppWithCurrentOrigin.sources }
      if (forkName && sources['config.json']) {
        try {
          sources['config.json'] = JSON.stringify({ ...JSON.parse(sources['config.json']), name: forkName }, null, 2)
        } catch {
          // Keep the original config if it is not valid JSON; the editor will surface the parse error.
        }
      }
      const newApps = {
        ...values.sceneApps,
        [newKeyword]: {
          ...sceneAppWithCurrentOrigin,
          sources,
          name: forkName,
        },
      }
      const newNodes = values.nodes.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, keyword: newKeyword } } : node
      )
      actions.setFrameFormValues({
        scenes: updateSceneAppsInScenes(
          values.editingFrame.scenes,
          props.sceneId,
          newApps,
          false,
          deselectNodes(newNodes)
        ),
      })
      actions.setNodes(newNodes)
    },
    undo: () => {
      const previous = values.history.past[values.history.past.length - 1]
      if (!previous) {
        return
      }
      cache.ignoreHistory = true
      actions.setFrameFormValues({
        scenes: values.editingFrame.scenes?.map((scene) =>
          scene.id === props.sceneId
            ? { ...scene, nodes: previous.nodes, edges: previous.edges, apps: previous.apps ?? {} }
            : scene
        ),
      })
      actions.setNodes(previous.nodes)
      actions.setEdges(previous.edges)
      window.setTimeout(() => {
        cache.ignoreHistory = false
      }, 0)
    },
    redo: () => {
      const next = values.history.past[values.history.past.length - 1]
      if (!next) {
        return
      }
      cache.ignoreHistory = true
      actions.setFrameFormValues({
        scenes: values.editingFrame.scenes?.map((scene) =>
          scene.id === props.sceneId ? { ...scene, nodes: next.nodes, edges: next.edges, apps: next.apps ?? {} } : scene
        ),
      })
      actions.setNodes(next.nodes)
      actions.setEdges(next.edges)
      window.setTimeout(() => {
        cache.ignoreHistory = false
      }, 0)
    },
    rearrangeCurrentScene: () => {
      const fieldOrderByNodeId = values.nodes.reduce((acc, node) => {
        let fields: (AppConfigField | MarkdownField)[] | null = null
        if (node.type === 'app' || node.type === 'source') {
          const keyword = (node.data as AppNodeData)?.keyword
          fields = keyword ? (values.effectiveApps[keyword] as AppConfig | undefined)?.fields ?? null : null
        } else if (node.type === 'dispatch' || node.type === 'event') {
          const keyword = (node.data as DispatchNodeData | EventNodeData)?.keyword
          const event = keyword ? events.find((event) => event.name === keyword) ?? null : null
          fields = event?.name === 'setSceneState' ? values.scene?.fields ?? null : event?.fields ?? null
        } else if (node.type === 'scene') {
          fields = values.scene?.fields ?? null
        }

        if (node.type === 'code') {
          const codeArgs = (node.data as CodeNodeData | undefined)?.codeArgs ?? []
          if (codeArgs.length > 0) {
            acc[node.id] = codeArgs.map((arg) => arg.name)
          }
          return acc
        }

        const order = fieldOrderFromFields(fields)
        if (order.length > 0) {
          acc[node.id] = order
        }
        return acc
      }, {} as Record<string, string[]>)

      actions.setNodes(arrangeNodes(values.nodes, values.edges, { fieldOrderByNodeId }))
      actions.fitDiagramView()
    },
    keywordDropped: async ({ keyword, type, position }) => {
      // Whenever something is dropped on the diagram from the side panel
      if (type === 'app') {
        let app = values.effectiveApps[keyword] ?? values.apps[keyword]
        if (!app) {
          console.error('App not found:', keyword)
          return
        }
        const installed = await installSceneAppForKeyword(values.sceneApps, keyword, app)
        const sceneApps = installed.sceneApps
        if (sceneApps !== values.sceneApps) {
          actions.setSceneApps(sceneApps, true)
          app = installed.app ?? app
        }
        const newNode: DiagramNode = {
          id: uuidv4(),
          type: 'app',
          position,
          data: { keyword: installed.keyword, config: {}, cache: { ...app.cache } } satisfies AppNodeData,
        }
        actions.setNodes([...values.nodes, newNode])
      } else if (type === 'event') {
        const newNode: DiagramNode = {
          id: uuidv4(),
          type: type,
          position,
          data: { keyword } satisfies EventNodeData,
        }
        actions.setNodes([...values.nodes, newNode])
      } else if (type === 'dispatch') {
        const newNode: DiagramNode = {
          id: uuidv4(),
          type: type,
          position,
          data: { keyword, config: {} } satisfies DispatchNodeData,
        }
        actions.setNodes([...values.nodes, newNode])
      } else if (type === 'state') {
        const newNode: DiagramNode = {
          id: uuidv4(),
          type: type,
          position,
          data: { keyword } satisfies StateNodeData,
        }
        actions.setNodes([...values.nodes, newNode])
      } else if (type === 'code') {
        const newNode: DiagramNode = {
          id: uuidv4(),
          type: type,
          position,
          style: { width: 300, height: 119 },
          data: { code: keyword, codeArgs: [], codeOutputs: [] } satisfies CodeNodeData,
        }
        actions.setNodes([...values.nodes, newNode])
      }
    },
    applyTemplate: () => {
      window.setTimeout(() => actions.fitDiagramView(), 50)
    },
    copyAppJSON: ({ nodeId }) => {
      const selectedNodes = values.nodes.filter((node) => node.selected)
      const nodesToCopy =
        selectedNodes.length > 0 ? selectedNodes : values.nodesById[nodeId] ? [values.nodesById[nodeId]] : []
      if (nodesToCopy.length === 0) {
        return
      }
      const selectedIds = new Set(nodesToCopy.map((node) => node.id))
      const edgesToCopy = values.rawEdges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
      copy(JSON.stringify(clipboardPayloadForNodes(nodesToCopy, edgesToCopy, values.sceneApps)))
    },
    copySelectedNodes: () => {
      const selectedNodes = values.nodes.filter((node) => node.selected)
      if (selectedNodes.length === 0) {
        return
      }
      const selectedIds = new Set(selectedNodes.map((node) => node.id))
      const edgesToCopy = values.rawEdges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
      copy(JSON.stringify(clipboardPayloadForNodes(selectedNodes, edgesToCopy, values.sceneApps)))
    },
    duplicateNode: ({ nodeId }) => {
      const node = values.nodesById[nodeId]
      if (!node) {
        return
      }
      const baseNodes = values.nodes.map((node) => (node.selected ? { ...node, selected: false } : node))
      const duplicatedNode = duplicateDiagramNode(node)
      const nextNodes = [...baseNodes, duplicatedNode]
      actions.setNodes(nextNodes)
      window.setTimeout(() => {
        props.updateNodeInternals?.(duplicatedNode.id)
      }, 200)
    },
    pasteFromClipboard: async () => {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
        console.warn('Clipboard API not available for pasting nodes')
        return
      }
      try {
        const clipboardText = await navigator.clipboard.readText()
        const parsed = JSON.parse(clipboardText)
        const payload = parseClipboardPayload(parsed)
        if (!payload) {
          throw new Error('Clipboard does not contain valid node JSON')
        }
        const { nodes, edges, apps } = payload
        if (nodes.length === 0) {
          return
        }
        const { sceneApps: nextSceneApps, keywordMap } = mergePastedSceneApps(nodes, values.sceneApps, apps)
        const offset = getClipboardOffset(nodes, values.cursorPosition)
        const idMap = new Map<string, string>()
        const baseNodes = values.nodes.map((node) => (node.selected ? { ...node, selected: false } : node))
        const baseEdges = values.rawEdges.map((edge) => (edge.selected ? { ...edge, selected: false } : edge))
        const pastedNodes = nodes.map((node) => {
          const newId = uuidv4()
          idMap.set(node.id, newId)
          const { position } = node
          const sanitizedNode = sanitizeClipboardNode(node)
          const keyword = getNodeAppKeyword(sanitizedNode)
          return {
            ...sanitizedNode,
            id: newId,
            data:
              keyword && keywordMap.has(keyword)
                ? { ...sanitizedNode.data, keyword: keywordMap.get(keyword) as string }
                : sanitizedNode.data,
            position: { x: (position?.x ?? 0) + offset.x, y: (position?.y ?? 0) + offset.y },
            selected: true,
          }
        })
        const pastedEdges = edges
          .filter((edge) => idMap.has(edge.source) && idMap.has(edge.target))
          .map((edge) => ({
            ...edge,
            id: uuidv4(),
            source: idMap.get(edge.source) as string,
            target: idMap.get(edge.target) as string,
            selected: false,
          }))
        const nextNodes = [...baseNodes, ...pastedNodes]
        const nextEdges = [...baseEdges, ...pastedEdges]
        flushHistorySnapshot(cache, actions)
        cache.ignoreHistory = true
        if (!equal(nextSceneApps, values.sceneApps)) {
          actions.setFrameFormValues({
            scenes: updateSceneAppsInScenes(values.editingFrame.scenes, props.sceneId, nextSceneApps, true),
          })
        }
        actions.setNodes(nextNodes)
        actions.setEdges(nextEdges)
        cache.ignoreHistory = false
        recordHistorySnapshot(cache, actions, makeHistorySnapshot(nextNodes, nextEdges, nextSceneApps))
        window.setTimeout(() => {
          pastedNodes.forEach((node) => props.updateNodeInternals?.(node.id))
        }, 200)
      } catch (error) {
        console.error('Failed to paste node from clipboard', error)
      }
    },
  })),
  afterMount(({ actions, values, cache }) => {
    window.setTimeout(actions.fitDiagramView, 10)
    window.setTimeout(actions.fitDiagramView, 100)
    cache.ignoreHistory = false
    cache.historyTimer = null
    cache.pendingHistorySnapshot = null
    cache.hasAutoArranged = false
    actions.resetHistory(makeHistorySnapshot(values.nodes, values.rawEdges, values.sceneApps))

    cache.keydownHandler = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return
      }
      if ((event.metaKey || event.ctrlKey) && hasTextSelection()) {
        return
      }
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === 'c') {
        event.preventDefault()
        actions.copySelectedNodes()
        return
      }
      if ((event.metaKey || event.ctrlKey) && key === 'v') {
        event.preventDefault()
        actions.pasteFromClipboard()
        return
      }
      if (!event.metaKey || key !== 'z') {
        return
      }
      event.preventDefault()
      flushHistorySnapshot(cache, actions)
      if (event.shiftKey) {
        actions.redo()
        return
      }
      actions.undo()
    }
    window.addEventListener('keydown', cache.keydownHandler)
  }),
  beforeUnmount(({ cache }) => {
    if (cache.keydownHandler) {
      window.removeEventListener('keydown', cache.keydownHandler)
      cache.keydownHandler = null
    }
    if (cache.historyTimer) {
      window.clearTimeout(cache.historyTimer)
      cache.historyTimer = null
    }
    cache.pendingHistorySnapshot = null
  }),
])
