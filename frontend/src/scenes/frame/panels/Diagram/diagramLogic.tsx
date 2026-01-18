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
  MarkdownField,
  StateNodeData,
} from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'
import { arrangeNodes } from '../../../../utils/arrangeNodes'
import copy from 'copy-to-clipboard'
import { Option } from '../../../../components/Select'
import _events from '../../../../../schema/events.json'

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
}

export type DiagramHistoryState = {
  past: DiagramHistorySnapshot[]
  future: DiagramHistorySnapshot[]
}

const MAX_HISTORY_LENGTH = 100
const HISTORY_DEBOUNCE_MS = 300

const normalizeNodes = (nodes: DiagramNode[]): DiagramNode[] =>
  nodes.map((node) => {
    const { selected, dragging, width, height, ...rest } = node
    if (node.type === 'code' && typeof width !== 'undefined' && typeof height !== 'undefined') {
      return { ...rest, width, height } as DiagramNode
    }
    return rest as DiagramNode
  })

const normalizeEdges = (edges: Edge[]): Edge[] =>
  edges.map((edge) => (edge.selected ? { ...edge, selected: false } : edge))

const makeHistorySnapshot = (nodes: DiagramNode[], edges: Edge[]): DiagramHistorySnapshot => ({
  nodes: normalizeNodes(nodes),
  edges: normalizeEdges(edges),
})

const scheduleHistorySnapshot = (
  cache: Record<string, any>,
  actions: { recordHistory: (snapshot: DiagramHistorySnapshot) => void },
  snapshot: DiagramHistorySnapshot
): void => {
  if (cache.historyTimer) {
    window.clearTimeout(cache.historyTimer)
  }
  cache.historyTimer = window.setTimeout(() => {
    cache.historyTimer = null
    actions.recordHistory(snapshot)
  }, HISTORY_DEBOUNCE_MS)
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.isContentEditable) {
    return true
  }
  if (target.closest('[contenteditable="true"]')) {
    return true
  }
  const tagName = target.tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
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
    updateNodeData: (id: string, data: Record<string, any>) => ({ id, data }),
    updateEdge: (edge: Edge) => ({ edge }),
    updateNodeConfig: (id: string, field: string, value: any) => ({ id, field, value }),
    copyAppJSON: (nodeId: string) => ({ nodeId }),
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
          if (last && equal(last, snapshot)) {
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
    selectedNode: [(s) => [s.nodes], (nodes): Node | null => nodes.find((node) => node.selected) ?? null],
    selectedNodeId: [(s) => [s.selectedNode], (node) => node?.id ?? null],
    selectedNodeIds: [
      (s) => [s.nodes],
      (nodes): string[] => nodes.filter((node) => node.selected).map((node) => node.id),
    ],
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
      (s) => [s.nodes, s.edges, s.sceneId, s.originalFrame],
      (nodes, edges, sceneId, originalFrame) => {
        const scene = originalFrame?.scenes?.find((s) => s.id === sceneId)
        return (
          !equal(
            nodes?.map((n) => (n.selected ? { ...n, selected: false } : n)),
            scene?.nodes
          ) ||
          !equal(
            edges?.map((e) => (e.selected ? { ...e, selected: false } : e)),
            scene?.edges
          )
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
  sharedListeners(({ selectors, actions, values, props }) => ({
    nodesChanged: (_, __, ___, previousState) => {
      const nodes = values.nodes
      const oldNodes = selectors.nodes(previousState)

      // Upon first render of a new scene, the nodes will have x = -9999, y = -9999, width = undefined, height = undefined
      // Upon second render, the width and height will have been set, but x and y will still be -9999 for all nodes
      // If we detect that case, automatically rearrange the scene.
      if (
        nodes.length > 0 &&
        nodes.every((node) => node.position.x === -9999 && node.position.y === -9999 && node.width && node.height)
      ) {
        actions.rearrangeCurrentScene()
      }

      // Do not update on first render
      if (typeof oldNodes !== 'undefined' && !equal(nodes, oldNodes)) {
        actions.setFrameFormValues({
          scenes: values.editingFrame.scenes?.map((scene) =>
            scene.id === props.sceneId && !equal(scene.nodes, nodes)
              ? // set the nodes on the scene's form, and remove the selected flag from all
                ({
                  ...scene,
                  nodes: nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
                } satisfies FrameScene)
              : scene
          ),
        })
      }
    },
  })),
  listeners(({ sharedListeners, props, values, actions }) => ({
    setNodes: sharedListeners.nodesChanged,
    onNodesChange: sharedListeners.nodesChanged,
    selectNode: sharedListeners.nodesChanged,
    deselectNode: sharedListeners.nodesChanged,
    updateNodeData: sharedListeners.nodesChanged,
    deleteApp: sharedListeners.nodesChanged,
    updateNodeConfig: ({ id, field, value }) => {
      const { nodes } = values
      actions.setFrameFormValues({
        scenes: values.editingFrame.scenes?.map((scene) =>
          scene.id === props.sceneId && !equal(scene.nodes, nodes)
            ? // set the nodes on the scene's form, and remove the selected flag from all
              ({
                ...scene,
                nodes: values.nodes.map((node) =>
                  node.id === id
                    ? {
                        ...node,
                        data: {
                          ...(node.data ?? {}),
                          config: { ...('config' in node.data ? node.data?.config ?? {} : {}), [field]: value },
                        },
                      }
                    : node
                ),
              } satisfies FrameScene)
            : scene
        ),
      })
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
        actions.resetHistory(makeHistorySnapshot(scene.nodes ?? [], scene.edges ?? []))
      }
    },
  })),
  listeners(({ actions, values, props, cache }) => ({
    setNodes: () => {
      if (cache.ignoreHistory) {
        return
      }
      actions.recordHistory(makeHistorySnapshot(values.nodes, values.rawEdges))
    },
    onNodesChange: ({ changes }) => {
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
      const snapshot = makeHistorySnapshot(values.nodes, values.rawEdges)
      const isDragging = changes.some((change) => change.type === 'position' && change.dragging)
      if (isDragging) {
        scheduleHistorySnapshot(cache, actions, snapshot)
        return
      }
      actions.recordHistory(snapshot)
    },
    updateNodeData: () => {
      if (cache.ignoreHistory) {
        return
      }
      scheduleHistorySnapshot(cache, actions, makeHistorySnapshot(values.nodes, values.rawEdges))
    },
    updateNodeConfig: () => {
      if (cache.ignoreHistory) {
        return
      }
      scheduleHistorySnapshot(cache, actions, makeHistorySnapshot(values.nodes, values.rawEdges))
    },
    deleteApp: () => {
      if (cache.ignoreHistory) {
        return
      }
      actions.recordHistory(makeHistorySnapshot(values.nodes, values.rawEdges))
    },
    setEdges: () => {
      if (cache.ignoreHistory) {
        return
      }
      actions.recordHistory(makeHistorySnapshot(values.nodes, values.rawEdges))
    },
    onEdgesChange: ({ changes }) => {
      if (cache.ignoreHistory) {
        return
      }
      if (changes.length > 0 && changes.every((change) => change.type === 'select')) {
        return
      }
      actions.recordHistory(makeHistorySnapshot(values.nodes, values.rawEdges))
    },
    addEdge: () => {
      if (cache.ignoreHistory) {
        return
      }
      actions.recordHistory(makeHistorySnapshot(values.nodes, values.rawEdges))
    },
    updateEdge: () => {
      if (cache.ignoreHistory) {
        return
      }
      actions.recordHistory(makeHistorySnapshot(values.nodes, values.rawEdges))
    },
    undo: () => {
      const previous = values.history.past[values.history.past.length - 1]
      if (!previous) {
        return
      }
      cache.ignoreHistory = true
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
          fields = keyword ? (values.apps[keyword] as AppConfig | undefined)?.fields ?? null : null
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
    keywordDropped: ({ keyword, type, position }) => {
      // Whenever something is dropped on the diagram from the side panel
      if (type === 'app') {
        const app = values.apps[keyword]
        if (!app) {
          console.error('App not found:', keyword)
          return
        }
        const newNode: DiagramNode = {
          id: uuidv4(),
          type: 'app',
          position,
          data: { keyword: keyword, config: {}, cache: { ...app.cache } } satisfies AppNodeData,
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
          data: { code: keyword } satisfies CodeNodeData,
        }
        actions.setNodes([...values.nodes, newNode])
      }
    },
    applyTemplate: () => {
      window.setTimeout(() => actions.fitDiagramView(), 50)
    },
    copyAppJSON: ({ nodeId }) => {
      const { nodes } = values
      const app = nodes.find((n) => n.id === nodeId)
      if (app) {
        copy(JSON.stringify(app))
      }
    },
  })),
  afterMount(({ actions, values, cache }) => {
    window.setTimeout(actions.fitDiagramView, 10)
    window.setTimeout(actions.fitDiagramView, 100)
    cache.ignoreHistory = false
    cache.historyTimer = null
    actions.resetHistory(makeHistorySnapshot(values.nodes, values.rawEdges))

    cache.keydownHandler = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return
      }
      if (!event.metaKey || event.key.toLowerCase() !== 'z') {
        return
      }
      event.preventDefault()
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
  }),
])
