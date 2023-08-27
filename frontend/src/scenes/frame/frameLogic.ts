import { actions, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../models/framesModel'
import { applyEdgeChanges, applyNodeChanges, addEdge, MarkerType } from 'reactflow'
import type { Node } from '@reactflow/core/dist/esm/types/nodes'
import type { Edge } from '@reactflow/core/dist/esm/types/edges'
import type { Connection } from '@reactflow/core/dist/esm/types/general'
import type { EdgeChange, NodeChange } from '@reactflow/core/dist/esm/types/changes'
import equal from 'fast-deep-equal'
import type { frameLogicType } from './frameLogicType'
import { subscriptions } from 'kea-subscriptions'
import { AppConfig, Area, Panel, PanelWithMetadata } from '../../types'

export interface FrameLogicProps {
  id: number
}

const DEFAULT_LAYOUT: Record<Area, PanelWithMetadata[]> = {
  [Area.TopLeft]: [{ panel: Panel.Diagram, active: true, hidden: false }],
  [Area.TopRight]: [
    { panel: Panel.Selection, active: false, hidden: true },
    { panel: Panel.AddApps, active: true, hidden: false },
    { panel: Panel.FrameDetails, active: false, hidden: false },
    { panel: Panel.FrameSettings, active: false, hidden: false },
  ],
  [Area.BottomLeft]: [{ panel: Panel.Logs, active: true, hidden: false }],
  [Area.BottomRight]: [{ panel: Panel.Image, active: true, hidden: false }],
}
export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.id),
  actions({
    setPanel: (area: Area, panel: string, label?: string) => ({ area, panel, label }),
    setNodes: (nodes: Node[]) => ({ nodes }),
    setEdges: (edges: Edge[]) => ({ edges }),
    addEdge: (edge: Edge | Connection) => ({ edge }),
    onNodesChange: (changes: NodeChange[]) => ({ changes }),
    onEdgesChange: (changes: EdgeChange[]) => ({ changes }),
    deselectNode: true,
  }),
  reducers({
    panels: [
      DEFAULT_LAYOUT as Record<Area, PanelWithMetadata[]>,
      {
        setPanel: (state, { area, panel, label }) => {
          const newPanels = { ...state }
          newPanels[area] = newPanels[area].map((p) => ({
            ...p,
            active: p.panel === panel,
            label: p.panel === panel && label ? label : p.label,
          }))
          return equal(state, newPanels) ? state : newPanels
        },
      },
    ],
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
    selectedApp: [(s) => [s.selectedNode], (node): AppConfig => node?.data.app ?? null],
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
                type: 'render',
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
  subscriptions(({ actions, cache, values }) => ({
    selectedNode: (selectedNode, oldSelectedNode) => {
      console.log({ selectedNode, oldSelectedNode })
      if (selectedNode) {
        for (const [area, panels] of Object.entries(values.panels)) {
          for (const panel of panels) {
            if (panel.panel === Panel.Selection) {
              actions.setPanel(area as Area, Panel.Selection, selectedNode.data?.app?.name)
              cache.panelBeforeSelection = panels.find((panel) => panel.active)?.panel
              return
            }
          }
        }
      } else {
        for (const [area, panels] of Object.entries(values.panels)) {
          if (panels.find((panel) => panel.panel === Panel.Selection)) {
            if (
              cache.panelBeforeSelection &&
              cache.panelBeforeSelection !== Panel.Selection &&
              panels.find((panel) => panel.panel === cache.panelBeforeSelection)
            ) {
              actions.setPanel(area as Area, cache.panelBeforeSelection)
              return
            }

            const first = panels.find((panel) => !panel.hidden)?.panel
            if (first) {
              actions.setPanel(area as Area, first)
            }
            return
          }
        }
      }
    },
  })),
])
