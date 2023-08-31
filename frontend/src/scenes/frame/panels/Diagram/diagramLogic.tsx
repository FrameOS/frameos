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
import { AppNodeData, EventNodeData, FrameScene } from '../../../../types'
import { arrangeNodes } from './arrangeNodes'
import { frameLogic } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'

export interface DiagramLogicProps {
  frameId: number
  sceneId: string
  onChange?: (nodes: Node[], edges: Edge[]) => void
}

export const diagramLogic = kea<diagramLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Diagram', 'diagramLogic']),
  props({} as DiagramLogicProps),
  key((props) => `${props.frameId}/${props.sceneId}`),
  connect((props: DiagramLogicProps) => ({
    values: [frameLogic({ id: props.frameId }), ['frame', 'frameForm'], appsModel, ['apps']],
  })),
  actions({
    setNodes: (nodes: Node[]) => ({ nodes }),
    setEdges: (edges: Edge[]) => ({ edges }),
    addEdge: (edge: Edge | Connection) => ({ edge }),
    onNodesChange: (changes: NodeChange[]) => ({ changes }),
    onEdgesChange: (changes: EdgeChange[]) => ({ changes }),
    deselectNode: true,
    rearrangeCurrentScene: true,
    fitDiagramView: true,
    keywordDropped: (keyword: string, type: string, position: XYPosition) => ({ keyword, type, position }),
  }),
  reducers({
    nodes: [
      [] as Node[],
      {
        setNodes: (_, { nodes }) => nodes,
        onNodesChange: (state, { changes }) => {
          const newNodes = applyNodeChanges(changes, state)
          return equal(state, newNodes) ? state : newNodes
        },
        deselectNode: (state) => {
          const newNodes = state.map((node) => ({ ...node, selected: false }))
          return equal(state, newNodes) ? state : newNodes
        },
      },
    ],
    edges: [
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
      },
    ],
    fitViewCounter: [0, { fitDiagramView: (state) => state + 1 }],
  }),
  selectors(() => ({
    frameId: [() => [(_, props) => props.frameId], (frameId) => frameId],
    sceneId: [() => [(_, props) => props.sceneId], (sceneId) => sceneId],
    editingFrame: [
      (s) => [s.frameForm, framesModel.selectors.frames, s.frameId],
      (frameForm, frames, frameId) => frameForm || frames[frameId] || null,
    ],
    scene: [
      (s) => [s.editingFrame, s.sceneId],
      (editingFrame, sceneId) => (editingFrame.scenes ?? []).find((s) => s.id === sceneId) || null,
    ],
    selectedNode: [(s) => [s.nodes], (nodes) => nodes.find((node) => node.selected) ?? null],
    selectedNodeId: [(s) => [s.selectedNode], (node) => node?.id ?? null],
  })),
  subscriptions(({ actions, values, props }) => ({
    nodes: (nodes: Node[], oldNodes: Node[]) => {
      // Upon first render of a new scene, the nodes will have x = -9999, y = -9999, width = undefined, height = undefined
      // Upon second render, the width and height will have been set, but x and y will still be -9999 for all nodes
      // If we detect that case, automatically rearrange the scene.
      if (
        nodes.length > 0 &&
        nodes.every((node) => node.position.x === -9999 && node.position.y === -9999 && node.width && node.height)
      ) {
        actions.rearrangeCurrentScene()
      }

      // Do not call `props.onChange` on first render
      if (typeof oldNodes !== 'undefined' && !equal(nodes, oldNodes)) {
        props?.onChange?.(nodes, values.edges)
      }
    },
    edges: (edges: Edge[], oldEdges: Edge[]) => {
      // Do not call `props.onChange` on first render
      if (typeof oldEdges !== 'undefined' && edges && !equal(edges, oldEdges)) {
        props?.onChange?.(values.nodes, edges)
      }
    },
    scene: (scene: FrameScene, oldScene: FrameScene) => {
      if (scene && !equal(scene.nodes, oldScene?.nodes)) {
        actions.setNodes(scene.nodes)
      }
      if (scene && !equal(scene.edges, oldScene?.edges)) {
        actions.setEdges(scene.edges)
      }
    },
  })),
  listeners(({ actions, values }) => ({
    rearrangeCurrentScene: () => {
      actions.setNodes(arrangeNodes(values.nodes, values.edges))
      actions.fitDiagramView()
    },
    keywordDropped: ({ keyword, type, position }) => {
      if (type === 'app') {
        const newNode: Node = {
          id: uuidv4(),
          type: 'app',
          position,
          data: { keyword: keyword, config: {} } as AppNodeData,
        }
        actions.setNodes([...values.nodes, newNode])
      } else if (type === 'event') {
        const newNode: Node = {
          id: uuidv4(),
          type: 'event',
          position,
          data: { keyword } as EventNodeData,
        }
        actions.setNodes([...values.nodes, newNode])
      }

      window.setTimeout(() => actions.fitDiagramView(), 50)
    },
  })),
  afterMount(({ actions }) => {
    window.setTimeout(actions.fitDiagramView, 10)
    window.setTimeout(actions.fitDiagramView, 100)
  }),
])
