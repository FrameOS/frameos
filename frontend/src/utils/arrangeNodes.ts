import dagre from '@dagrejs/dagre'
import type { Edge } from '@reactflow/core/dist/esm/types/edges'
import type { DiagramNode } from '../types'

const NODE_PADDING_X = 60
const NODE_PADDING_Y = 50
const NODE_FALLBACK_WIDTH = 260
const NODE_FALLBACK_HEIGHT = 180

function getNodeSize(node: DiagramNode): { width: number; height: number } {
  return {
    width: node.width ?? NODE_FALLBACK_WIDTH,
    height: node.height ?? NODE_FALLBACK_HEIGHT,
  }
}

export function arrangeNodes(nodes: DiagramNode[], edges: Edge[]): DiagramNode[] {
  if (!nodes.length) {
    return nodes
  }

  const graph = new dagre.graphlib.Graph({ multigraph: true })
  graph.setGraph({
    rankdir: 'LR',
    nodesep: NODE_PADDING_X,
    ranksep: NODE_PADDING_Y,
    edgesep: 25,
  })
  graph.setDefaultEdgeLabel(() => ({}))

  nodes.forEach((node) => {
    const { width, height } = getNodeSize(node)
    graph.setNode(node.id, {
      width,
      height,
      rank: node.type === 'event' || node.type === 'source' ? 'min' : undefined,
    })
  })

  edges.forEach((edge) => {
    if (!edge.source || !edge.target || edge.source === edge.target) {
      return
    }
    graph.setEdge(edge.source, edge.target)
  })

  dagre.layout(graph)

  const positionedNodes = nodes.map((node) => {
    const layoutNode = graph.node(node.id)
    if (!layoutNode) {
      return node
    }
    const { width, height } = getNodeSize(node)
    return {
      ...node,
      position: {
        x: layoutNode.x - width / 2,
        y: layoutNode.y - height / 2,
      },
    }
  })

  return positionedNodes
}
