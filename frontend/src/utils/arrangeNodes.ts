import dagre from '@dagrejs/dagre'
import type { Edge } from '@reactflow/core/dist/esm/types/edges'
import type { DiagramNode } from '../types'

const NODE_PADDING_X = 60
const NODE_PADDING_Y = 50
const NODE_FALLBACK_WIDTH = 260
const NODE_FALLBACK_HEIGHT = 180
const CODE_NODE_MIN_WIDTH = 700
const CODE_NODE_MIN_HEIGHT = 400
const CODE_ARG_HORIZONTAL_PADDING = 40
const CODE_ARG_MAX_LEVEL = 5

interface ArrangeNodesOptions {
  fieldOrderByNodeId?: Record<string, string[]>
}

function getNodeSize(node: DiagramNode): { width: number; height: number } {
  return {
    width: node.width ?? NODE_FALLBACK_WIDTH,
    height: node.height ?? NODE_FALLBACK_HEIGHT,
  }
}

function expandCodeNode(node: DiagramNode): DiagramNode {
  if (node.type !== 'code') {
    return node
  }
  const width = Math.max(node.width ?? NODE_FALLBACK_WIDTH, CODE_NODE_MIN_WIDTH)
  const height = Math.max(node.height ?? NODE_FALLBACK_HEIGHT, CODE_NODE_MIN_HEIGHT)
  return { ...node, width, height }
}

function fieldNameFromHandle(handle?: string | null): string | null {
  if (!handle) {
    return null
  }
  if (handle.startsWith('fieldInput/')) {
    return handle.slice('fieldInput/'.length)
  }
  if (handle.startsWith('codeField/')) {
    return handle.slice('codeField/'.length)
  }
  if (handle.startsWith('field/')) {
    return handle.slice('field/'.length)
  }
  return null
}

function isFlowEdge(edge: Edge): boolean {
  return edge.sourceHandle === 'next' || edge.targetHandle === 'prev' || edge.type === 'appNodeEdge'
}

function isDataAppNode(node: DiagramNode): boolean {
  if (node.type !== 'app') {
    return false
  }
  const keyword = (node.data as { keyword?: string } | undefined)?.keyword
  return typeof keyword === 'string' && keyword.startsWith('data/')
}

function isFlowNode(node: DiagramNode): boolean {
  if (node.type === 'event' || node.type === 'dispatch') {
    return true
  }
  if (node.type === 'app') {
    return !isDataAppNode(node)
  }
  return false
}

export function arrangeNodes(nodes: DiagramNode[], edges: Edge[], options: ArrangeNodesOptions = {}): DiagramNode[] {
  if (!nodes.length) {
    return nodes
  }

  const sizedNodes = nodes.map(expandCodeNode)
  const flowNodes = sizedNodes.filter(isFlowNode)
  const flowNodeIds = new Set(flowNodes.map((node) => node.id))
  const flowEdges = edges.filter(
    (edge) => flowNodeIds.has(edge.source) && flowNodeIds.has(edge.target) && isFlowEdge(edge)
  )

  if (!flowNodes.length) {
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

  flowNodes.forEach((node) => {
    const { width, height } = getNodeSize(node)
    graph.setNode(node.id, {
      width,
      height,
      rank: node.type === 'event' || node.type === 'source' ? 'min' : undefined,
    })
  })

  flowEdges.forEach((edge) => {
    if (!edge.source || !edge.target || edge.source === edge.target) {
      return
    }
    graph.setEdge(edge.source, edge.target)
  })

  dagre.layout(graph)

  const basePositions = new Map<string, { x: number; y: number }>()
  flowNodes.forEach((node) => {
    const layoutNode = graph.node(node.id)
    if (!layoutNode) {
      return
    }
    const { width, height } = getNodeSize(node)
    basePositions.set(node.id, {
      x: layoutNode.x - width / 2,
      y: layoutNode.y - height / 2,
    })
  })

  const outgoingEdges = edges.reduce((acc, edge) => {
    if (!edge.source || !edge.target) {
      return acc
    }
    acc[edge.source] = [...(acc[edge.source] ?? []), edge]
    return acc
  }, {} as Record<string, Edge[]>)
  const incomingEdges = edges.reduce((acc, edge) => {
    if (!edge.source || !edge.target) {
      return acc
    }
    acc[edge.target] = [...(acc[edge.target] ?? []), edge]
    return acc
  }, {} as Record<string, Edge[]>)

  const anchorCache = new Map<string, string | null>()
  const resolveAnchor = (nodeId: string, visited = new Set<string>()): string | null => {
    if (anchorCache.has(nodeId)) {
      return anchorCache.get(nodeId) ?? null
    }
    if (flowNodeIds.has(nodeId)) {
      anchorCache.set(nodeId, nodeId)
      return nodeId
    }
    if (visited.has(nodeId)) {
      return null
    }
    visited.add(nodeId)
    for (const edge of outgoingEdges[nodeId] ?? []) {
      const anchor = resolveAnchor(edge.target, visited)
      if (anchor) {
        anchorCache.set(nodeId, anchor)
        return anchor
      }
    }
    for (const edge of incomingEdges[nodeId] ?? []) {
      const anchor = resolveAnchor(edge.source, visited)
      if (anchor) {
        anchorCache.set(nodeId, anchor)
        return anchor
      }
    }
    anchorCache.set(nodeId, null)
    return null
  }

  const depthCache = new Map<string, number>()
  const resolveDepth = (nodeId: string, anchorId: string, visited = new Set<string>()): number => {
    const cacheKey = `${nodeId}:${anchorId}`
    if (depthCache.has(cacheKey)) {
      return depthCache.get(cacheKey) ?? 0
    }
    if (nodeId === anchorId) {
      depthCache.set(cacheKey, 0)
      return 0
    }
    if (visited.has(nodeId)) {
      return 0
    }
    visited.add(nodeId)
    let best = 0
    for (const edge of outgoingEdges[nodeId] ?? []) {
      const depth = resolveDepth(edge.target, anchorId, visited)
      if (depth > 0 || edge.target === anchorId) {
        best = Math.max(best, depth + 1)
      }
    }
    depthCache.set(cacheKey, best)
    return best
  }

  const nodesById = sizedNodes.reduce((acc, node) => {
    acc[node.id] = node
    return acc
  }, {} as Record<string, DiagramNode>)

  const anchoredNodes = sizedNodes.filter((node) => !flowNodeIds.has(node.id))
  const nodesByAnchor = anchoredNodes.reduce((acc, node) => {
    const anchor = resolveAnchor(node.id)
    if (!anchor) {
      return acc
    }
    acc[anchor] = [...(acc[anchor] ?? []), node]
    return acc
  }, {} as Record<string, DiagramNode[]>)

  const positionedNodes = sizedNodes.map((node) => {
    const basePosition = basePositions.get(node.id)
    if (!basePosition) {
      return node
    }
    return { ...node, position: { ...basePosition } }
  })

  const positionedById = positionedNodes.reduce((acc, node) => {
    acc[node.id] = node
    return acc
  }, {} as Record<string, DiagramNode>)

  const fieldOrderByNodeId = options.fieldOrderByNodeId ?? {}
  const offsetCache = new Map<string, number>()
  const resolveFieldOffset = (nodeId: string): number => {
    if (offsetCache.has(nodeId)) {
      return offsetCache.get(nodeId) ?? 0
    }
    const nodeEdges = [...(outgoingEdges[nodeId] ?? []), ...(incomingEdges[nodeId] ?? [])]
    let bestIndex: number | null = null
    for (const edge of nodeEdges) {
      let ownerId: string | null = null
      let fieldName: string | null = null
      if (edge.source === nodeId) {
        fieldName = fieldNameFromHandle(edge.targetHandle)
        ownerId = fieldName ? edge.target : null
      } else if (edge.target === nodeId) {
        fieldName = fieldNameFromHandle(edge.sourceHandle)
        ownerId = fieldName ? edge.source : null
      }
      if (!ownerId || !fieldName) {
        continue
      }
      const fieldOrder = fieldOrderByNodeId[ownerId] ?? []
      const fieldIndex = fieldOrder.indexOf(fieldName)
      if (fieldIndex < 0) {
        continue
      }
      if (bestIndex === null || fieldIndex < bestIndex) {
        bestIndex = fieldIndex
      }
    }
    const offset = bestIndex === null ? 0 : 10 + bestIndex * 15
    offsetCache.set(nodeId, offset)
    return offset
  }

  Object.entries(nodesByAnchor).forEach(([anchorId, anchored]) => {
    const anchorNode = positionedById[anchorId] ?? nodesById[anchorId]
    if (!anchorNode) {
      return
    }
    const anchorSize = getNodeSize(anchorNode)
    const anchorX = anchorNode.position.x
    const anchorY = anchorNode.position.y
    const anchoredNodes = [...anchored]

    const sortByDepth = (node: DiagramNode) => resolveDepth(node.id, anchorId)
    anchoredNodes.sort((a, b) => sortByDepth(b) - sortByDepth(a))

    const aboveTotalHeight =
      anchoredNodes.reduce((sum, node) => sum + getNodeSize(node).height, 0) +
      Math.max(0, anchoredNodes.length - 1) * NODE_PADDING_Y
    let currentY = anchorY - NODE_PADDING_Y - aboveTotalHeight
    anchoredNodes.forEach((node) => {
      const size = getNodeSize(node)
      const fieldOffset = resolveFieldOffset(node.id)
      positionedById[node.id] = {
        ...node,
        position: {
          x: anchorX - fieldOffset,
          y: currentY,
        },
      }
      currentY += size.height + NODE_PADDING_Y
    })
  })

  const codeArgUsage = new Map<string, number>()
  edges.forEach((edge) => {
    if (!edge.target || !edge.source) {
      return
    }
    if (!edge.targetHandle?.startsWith('codeField/')) {
      return
    }
    const codeNode = positionedById[edge.target] ?? nodesById[edge.target]
    if (!codeNode || codeNode.type !== 'code') {
      return
    }
    const sourceNode = positionedById[edge.source] ?? nodesById[edge.source]
    if (!sourceNode || isFlowNode(sourceNode)) {
      return
    }
    const argName = fieldNameFromHandle(edge.targetHandle)
    const argOrder = fieldOrderByNodeId[codeNode.id] ?? []
    const argIndex = argName ? argOrder.indexOf(argName) : -1
    if (argIndex < 0) {
      return
    }
    const sourceSize = getNodeSize(sourceNode)
    const codeSize = getNodeSize(codeNode)
    const usableWidth = Math.max(codeSize.width - CODE_ARG_HORIZONTAL_PADDING * 2, 1)
    const argSpacing = argOrder.length > 1 ? usableWidth / (argOrder.length - 1) : 0
    const argX = codeNode.position.x + CODE_ARG_HORIZONTAL_PADDING + argSpacing * argIndex
    const usageKey = `${codeNode.id}:${argName}`
    const usageCount = codeArgUsage.get(usageKey) ?? 0
    codeArgUsage.set(usageKey, usageCount + 1)
    const level = usageCount % CODE_ARG_MAX_LEVEL
    const baseY = codeNode.position.y - NODE_PADDING_Y - sourceSize.height
    positionedById[sourceNode.id] = {
      ...sourceNode,
      position: {
        x: argX - sourceSize.width / 2,
        y: baseY - level * NODE_PADDING_Y,
      },
    }
  })

  const resolveOverlaps = (nodesToResolve: DiagramNode[], passes: number): void => {
    const bumpX = NODE_PADDING_X
    const bumpY = NODE_PADDING_Y
    for (let pass = 0; pass < passes; pass += 1) {
      let moved = false
      for (let i = 0; i < nodesToResolve.length; i += 1) {
        const nodeA = positionedById[nodesToResolve[i].id] ?? nodesToResolve[i]
        const sizeA = getNodeSize(nodeA)
        for (let j = i + 1; j < nodesToResolve.length; j += 1) {
          const nodeB = positionedById[nodesToResolve[j].id] ?? nodesToResolve[j]
          const sizeB = getNodeSize(nodeB)
          const overlapX =
            nodeA.position.x < nodeB.position.x + sizeB.width && nodeA.position.x + sizeA.width > nodeB.position.x
          const overlapY =
            nodeA.position.y < nodeB.position.y + sizeB.height && nodeA.position.y + sizeA.height > nodeB.position.y
          if (overlapX && overlapY) {
            positionedById[nodeB.id] = {
              ...nodeB,
              position: {
                x: nodeB.position.x + bumpX,
                y: nodeB.position.y + bumpY,
              },
            }
            moved = true
          }
        }
      }
      if (!moved) {
        break
      }
    }
  }

  const resolvedNodes = sizedNodes.map((node) => positionedById[node.id] ?? node)
  resolveOverlaps(resolvedNodes, 3)

  return sizedNodes.map((node) => positionedById[node.id] ?? node)
}
