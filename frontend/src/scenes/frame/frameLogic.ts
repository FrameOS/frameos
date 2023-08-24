import { actions, kea, key, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../models/framesModel'
import {
  Edge,
  Connection,
  Node,
  NodeChange,
  EdgeChange,
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  MarkerType,
} from 'reactflow'
import equal from 'fast-deep-equal'
import type { frameLogicType } from './frameLogicType'
import { subscriptions } from 'kea-subscriptions'
import { AppConfig } from '../../types'

export interface FrameLogicProps {
  id: number
}

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.id),
  actions({
    setTab: (tab: string) => ({ tab }),
    setNodes: (nodes: Node[]) => ({ nodes }),
    setEdges: (edges: Edge[]) => ({ edges }),
    addEdge: (edge: Edge | Connection) => ({ edge }),
    onNodesChange: (changes: NodeChange[]) => ({ changes }),
    onEdgesChange: (changes: EdgeChange[]) => ({ changes }),
    deselectNode: true,
  }),
  reducers({
    tab: ['diagram', { setTab: (_, { tab }) => tab }],
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
          const newEdges = addEdge(edge, state)
          return equal(state, newEdges) ? state : newEdges
        },
      },
    ],
  }),
  selectors(() => ({
    id: [() => [(_, props) => props.id], (id) => id],
    frame: [(s) => [framesModel.selectors.frames, s.id], (frames, id) => frames[id] || null],
    selectedNode: [(s) => [s.nodes], (nodes) => nodes.find((node) => node.selected) ?? null],
    selectedNodeId: [(s) => [s.selectedNode], (node) => node?.id ?? null],
  })),
  subscriptions(({ actions }) => ({
    frame: (value, oldValue) => {
      if (value && JSON.stringify(value.apps) !== JSON.stringify(oldValue?.apps)) {
        const apps: AppConfig[] = value.apps || []
        actions.setNodes(
          apps
            .map(
              (app, index) =>
                ({
                  id: String(index + 1),
                  type: 'app',
                  position: { x: 0 + index * 200, y: 0 },
                  data: { label: app.name, app },
                } as Node)
            )
            .concat([
              {
                id: '0',
                type: 'output',
                position: { x: 0 + (apps.length ?? 0) * 200, y: 80 },
                data: { label: 'Render Frame' },
              } as Node,
            ])
        )
        actions.setEdges([
          {
            id: 'e1-2',
            source: '1',
            target: '2',
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 20,
              height: 20,
              color: '#FF0072',
            },
            style: {
              strokeWidth: 2,
              stroke: '#FF0072',
            },
          },
          {
            id: 'e2-3',
            source: '2',
            target: '3',
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 20,
              height: 20,
              color: '#FF0072',
            },
            style: {
              strokeWidth: 2,
              stroke: '#FF0072',
            },
          },
          {
            id: 'e3-0',
            source: '3',
            target: '0',
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 20,
              height: 20,
              color: '#FF0072',
            },
            style: {
              strokeWidth: 2,
              stroke: '#FF0072',
            },
          },
        ])
      }
    },
  })),
])
