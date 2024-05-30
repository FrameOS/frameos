import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
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
  App,
  AppNodeData,
  CodeNodeData,
  DiagramNode,
  DispatchNodeData,
  EventNodeData,
  FrameScene,
  StateField,
} from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'
import { arrangeNodes } from '../../../../utils/arrangeNodes'
import copy from 'copy-to-clipboard'
import { Option } from '../../../../components/Select'
import { stateFieldAccess } from '../../../../utils/fieldTypes'

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

export function getNewField(codeFields: string[]): string {
  let newField = 'arg'
  let i = 1
  while (codeFields.includes(newField)) {
    newField = `arg${i}`
    i++
  }
  return newField
}

function getAppsForType(apps: Record<string, App>, returnType: string = 'image'): Record<string, App> {
  const imageApps: Record<string, App> = {}
  for (const [keyword, app] of Object.entries(apps)) {
    if (app.output && app.output.length > 0 && app.output[0].type === returnType) {
      imageApps[keyword] = app
    }
  }
  return imageApps
}
function toBaseType(type: string): string {
  if (['string', 'select', 'text'].includes(type)) {
    return 'string'
  }
  return type
}

function typesMatch(type1: string, type2: string): boolean {
  return toBaseType(type1) === toBaseType(type2)
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
    updateNodeConfig: (id: string, field: string, value: any) => ({ id, field, value }),
    copyAppJSON: (nodeId: string) => ({ nodeId }),
    deleteApp: (id: string) => ({ id }),
    openNewNodePicker: (
      screenX: number,
      screenY: number,
      diagramX: number,
      diagramY: number,
      nodeId: string,
      handleId: string,
      handleType: string
    ) => ({
      screenX,
      screenY,
      diagramX,
      diagramY,
      nodeId,
      handleId,
      handleType,
    }),
    selectNewNodeOption: (newNodePicker: NewNodePicker, value: string, label: string) => ({
      newNodePicker,
      value,
      label,
    }),
    closeNewNodePicker: true,
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
      },
    ],
    fitViewCounter: [0, { fitDiagramView: (state) => state + 1 }],
    newNodePicker: [
      null as NewNodePicker | null,
      {
        openNewNodePicker: (_, { screenX, screenY, diagramX, diagramY, handleId, handleType, nodeId }) => ({
          screenX,
          screenY,
          diagramX,
          diagramY,
          handleId,
          handleType,
          nodeId,
        }),
        closeNewNodePicker: () => null,
      },
    ],
    newNodePickerIndex: [
      0,
      {
        openNewNodePicker: (state) => state + 1,
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
    edges: [
      (s) => [s.rawEdges],
      (rawEdges): Edge[] =>
        rawEdges.map((edge) =>
          edge.sourceHandle === 'fieldOutput' || edge.targetHandle?.startsWith('fieldInput/')
            ? edge.type !== 'codeNodeEdge'
              ? { ...edge, type: 'codeNodeEdge' }
              : edge
            : edge.type !== 'appNodeEdge'
            ? { ...edge, type: 'appNodeEdge' }
            : edge
        ),
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
      (nodes: DiagramNode[]): Record<string, DiagramNode[]> => {
        return nodes.reduce((acc, node) => {
          acc[node.id] = [...(acc[node.id] ?? []), node]
          return acc
        }, {} as Record<string, DiagramNode[]>)
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
    newNodeHandleDataType: [
      (s) => [s.newNodePicker, s.nodesById, s.apps, s.scene],
      (newNodePicker, nodesById, apps, scene): string | null => {
        if (!newNodePicker) {
          return null
        }
        const { handleId, handleType, nodeId } = newNodePicker
        const [node] = nodesById[nodeId] ?? []
        if (!node) {
          return null
        }
        if (handleType === 'target' && handleId.startsWith('fieldInput/')) {
          const key = handleId.split('/', 2)[1]
          if (node.type === 'app' && (node.data as AppNodeData)?.sources?.['config.json']) {
            try {
              const json = JSON.parse((node.data as AppNodeData)?.sources?.['config.json'] ?? '{}')
              const field = json.fields?.find((f) => 'name' in f && f.name === key)
              const type = field && 'type' in field ? field.type || null : null
              return type ? toBaseType(type) : null
            } catch (e) {
              console.error(e)
            }
          } else if (node.type === 'app' && node.data && 'keyword' in node.data && apps[node.data?.keyword]) {
            const app = apps[node.data.keyword]
            const field = app.fields?.find((f) => 'name' in f && f.name === key)
            const type = field && 'type' in field ? field.type || null : null
            return type ? toBaseType(type) : null
          }
        }
        if (handleType === 'target' && handleId.startsWith('codeField/')) {
          console.error('Must add type support to code field arguments!')
        }
        return null
      },
    ],
    newNodeOptions: [
      (s) => [s.newNodePicker, s.nodesById, s.apps, s.scene, s.newNodeHandleDataType],
      (newNodePicker, nodesById, apps, scene, newNodeHandleDataType): Option[] => {
        if (!newNodePicker) {
          return []
        }
        const { handleId, handleType, nodeId } = newNodePicker
        const [node] = nodesById[nodeId] ?? []
        console.log({ node, handleId, handleType, apps })
        const options: Option[] = []

        // Pulling out a field to the left of an app to specify a custom input
        if (handleType === 'target' && (handleId.startsWith('fieldInput/') || handleId.startsWith('codeField/'))) {
          const key = handleId.split('/', 2)[1]

          options.push({ label: 'Code', value: 'code' })
          if (newNodeHandleDataType) {
            const imageApps = getAppsForType(apps, newNodeHandleDataType)
            for (const [keyword, app] of Object.entries(imageApps)) {
              options.push({ label: `App: ${app.name}`, value: `app/${keyword}` })
            }
            for (const field of (scene?.fields ?? []).filter(
              (f) => 'type' in f && typesMatch(f.type, newNodeHandleDataType)
            )) {
              options.push({
                label: `State: ${field.label}`,
                value: `code/${stateFieldAccess(field)}`,
              })
            }
          } else if (handleId === 'codeField/+') {
            for (const [keyword, app] of Object.entries(apps)) {
              if (app.output && app.output.length > 0) {
                options.push({ label: `App: ${app.name}`, value: `app/${keyword}` })
              }
            }
            for (const field of scene?.fields ?? []) {
              options.push({
                label: `State: ${field.label}`,
                value: `code/${stateFieldAccess(field)}`,
              })
            }
          } else {
            options.push({ label: 'Error: unknown new node data type', value: 'app' })
            console.log(`Unknown handle type ${handleType} or handle id ${handleId}. Node: ${nodeId}`)
          }
        } else {
          options.push({ label: 'Error: unknown everything', value: 'app' })
          console.log(`Unknown handle type ${handleType} or handle id ${handleId}. Node: ${nodeId}`)
        }

        return options
      },
      { resultEqualityCheck: equal },
    ],
  }),
  subscriptions(({ actions, values, props }) => ({
    nodes: (nodes: DiagramNode[], oldNodes: DiagramNode[]) => {
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
        const selectedNodeId = values.selectedNodeId
        actions.setNodes(scene.nodes.map((n) => (n.id === selectedNodeId ? { ...n, selected: true } : n)))
      }
      if (scene && !equal(scene.edges, oldScene?.edges)) {
        // edges changed on the form, update our local state, but retain the selected flag
        const selectedEdgeId = values.selectedEdgeId
        actions.setEdges(scene.edges.map((e) => (e.id === selectedEdgeId ? { ...e, selected: true } : e)))
      }
    },
  })),
  listeners(({ actions, values, props }) => ({
    rearrangeCurrentScene: () => {
      actions.setNodes(arrangeNodes(values.nodes, values.edges))
      actions.fitDiagramView()
    },
    keywordDropped: ({ keyword, type, position }) => {
      if (type === 'app') {
        const newNode: DiagramNode = {
          id: uuidv4(),
          type: 'app',
          position,
          data: { keyword: keyword, config: {} } satisfies AppNodeData,
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
    selectNewNodeOption: ({ newNodePicker: { diagramX, diagramY, nodeId, handleId, handleType }, label, value }) => {
      const newNode: DiagramNode = {
        id: uuidv4(),
        position: { x: diagramX, y: diagramY },
        data: {} as any,
        style: {
          width: 300,
          height: 130,
        },
      }
      let newNodeOutputHandle = 'fieldOutput'

      if (value === 'code' || value.startsWith('code/')) {
        newNode.position.x -= 20
        newNode.position.y -= 100
        newNode.type = 'code'
        newNode.data = { code: value.startsWith('code/') ? value.substring(5) : '', codeFields: [] }
      } else if (value.startsWith('app/')) {
        const keyword = value.substring(4)
        const app = values.apps[keyword]
        newNode.type = 'app'
        newNode.data = { keyword, config: {} }
      } else {
        return
      }

      if (handleId === 'codeField/+') {
        const codeFields = (values.nodes.find((node) => node.id === nodeId)?.data as CodeNodeData)?.codeFields ?? []
        let newField = getNewField(codeFields)
        actions.setNodes([
          ...values.nodes.map((node) =>
            node.id === nodeId ? { ...node, data: { ...node.data, codeFields: [...codeFields, newField] } } : node
          ),
          newNode,
        ])
        window.requestAnimationFrame(() => {
          actions.addEdge({
            id: uuidv4(),
            target: nodeId,
            targetHandle: `codeField/${newField}`,
            source: newNode.id,
            sourceHandle: newNodeOutputHandle,
          })
          window.setTimeout(() => {
            props.updateNodeInternals?.(nodeId)
            props.updateNodeInternals?.(newNode.id)
          }, 200)
        })
      } else {
        actions.setNodes([...values.nodes, newNode])
        window.requestAnimationFrame(() => {
          actions.addEdge({
            id: uuidv4(),
            target: nodeId,
            targetHandle: handleId,
            source: newNode.id,
            sourceHandle: newNodeOutputHandle,
          })
          window.setTimeout(() => {
            props.updateNodeInternals?.(nodeId)
            props.updateNodeInternals?.(newNode.id)
          }, 200)
        })
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
  afterMount(({ actions }) => {
    window.setTimeout(actions.fitDiagramView, 10)
    window.setTimeout(actions.fitDiagramView, 100)
  }),
])
