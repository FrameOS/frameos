import dagre from '@dagrejs/dagre'
import type { Edge } from '@reactflow/core/dist/esm/types/edges'
import type { CodeNodeData, DiagramNode } from '../types'

const FLOW_NODE_SEPARATION = 90
const FLOW_RANK_SEPARATION = 220
const ANCHOR_VERTICAL_GAP = 90
const ANCHOR_HORIZONTAL_GAP = 70
const FIELD_SLOT_PADDING_X = 44
const COLLISION_GAP_X = 40
const COLLISION_GAP_Y = 40
const COLLISION_PASSES = 24
const STATE_INPUT_LEFT_OFFSET = 32
const STATE_INPUT_STAGGER_X = 12
const STATE_INPUT_VERTICAL_GAP = COLLISION_GAP_Y
const STATE_INPUT_HORIZONTAL_GAP = 28
const NODE_FALLBACK_WIDTH = 260
const NODE_FALLBACK_HEIGHT = 180
const CODE_NODE_MIN_WIDTH = 360
const CODE_NODE_MIN_HEIGHT = 220
const CODE_NODE_EXPANDED_MIN_WIDTH = 700
const CODE_NODE_EXPANDED_MIN_HEIGHT = 400
const CODE_NODE_COMPACT_MAX_LINES = 4
const CODE_NODE_COMPACT_MAX_CHARS = 160
const CODE_ARG_HORIZONTAL_PADDING = 40

interface ArrangeNodesOptions {
  fieldOrderByNodeId?: Record<string, string[]>
}

interface RowItem {
  node: DiagramNode
  desiredCenterX: number
  order: number
}

interface RowLayoutItem extends RowItem {
  left: number
  width: number
}

function getNodeSize(node: DiagramNode): { width: number; height: number } {
  return {
    width: node.width ?? NODE_FALLBACK_WIDTH,
    height: node.height ?? NODE_FALLBACK_HEIGHT,
  }
}

function getCodeNodeMinSize(node: DiagramNode): { width: number; height: number } {
  const data = (node.data as CodeNodeData | undefined) ?? {}
  const code = (data.codeJS ?? data.code ?? '').trim()
  if (!code) {
    return { width: CODE_NODE_MIN_WIDTH, height: CODE_NODE_MIN_HEIGHT }
  }
  const lines = code.split(/\r?\n/)
  const maxLineLength = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const isCompact =
    lines.length <= CODE_NODE_COMPACT_MAX_LINES &&
    maxLineLength <= CODE_NODE_COMPACT_MAX_CHARS / 2 &&
    code.length <= CODE_NODE_COMPACT_MAX_CHARS
  if (isCompact) {
    return { width: CODE_NODE_MIN_WIDTH, height: CODE_NODE_MIN_HEIGHT }
  }
  return { width: CODE_NODE_EXPANDED_MIN_WIDTH, height: CODE_NODE_EXPANDED_MIN_HEIGHT }
}

function expandCodeNode(node: DiagramNode): DiagramNode {
  if (node.type !== 'code') {
    return node
  }
  const minSize = getCodeNodeMinSize(node)
  const width = Math.max(node.width ?? NODE_FALLBACK_WIDTH, minSize.width)
  const height = Math.max(node.height ?? NODE_FALLBACK_HEIGHT, minSize.height)
  const style = { ...(node.style ?? {}), width, height }
  return { ...node, width, height, style }
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

function isStateInputTargetNode(node: DiagramNode): boolean {
  if (node.type !== 'app') {
    return false
  }
  const keyword = (node.data as { keyword?: string } | undefined)?.keyword
  return typeof keyword === 'string' && (keyword.startsWith('data/') || keyword.startsWith('logic/'))
}

function isAlwaysFlowNode(node: DiagramNode): boolean {
  if (node.type === 'event' || node.type === 'dispatch' || node.type === 'source') {
    return true
  }
  return false
}

function nodeCenterX(node: DiagramNode): number {
  return node.position.x + getNodeSize(node).width / 2
}

function handleOrderIndex(
  nodeId: string,
  handle: string | null | undefined,
  fieldOrderByNodeId: Record<string, string[]>
): number {
  const fieldName = fieldNameFromHandle(handle)
  if (!fieldName) {
    return Number.MAX_SAFE_INTEGER
  }
  const fieldOrder = fieldOrderByNodeId[nodeId] ?? []
  const index = fieldOrder.indexOf(fieldName)
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

function orderedFieldCenterX(
  node: DiagramNode,
  handle: string | null | undefined,
  fieldOrderByNodeId: Record<string, string[]>
): number | null {
  const fieldName = fieldNameFromHandle(handle)
  if (!fieldName) {
    return null
  }

  const fieldOrder = fieldOrderByNodeId[node.id] ?? []
  const fieldIndex = fieldOrder.indexOf(fieldName)
  if (fieldIndex < 0) {
    return null
  }

  const { width } = getNodeSize(node)
  const padding = handle?.startsWith('codeField/') ? CODE_ARG_HORIZONTAL_PADDING : FIELD_SLOT_PADDING_X
  const usableWidth = Math.max(width - padding * 2, 1)
  const denominator = Math.max(fieldOrder.length - 1, 1)
  return node.position.x + padding + (usableWidth * fieldIndex) / denominator
}

function handleCenterX(
  node: DiagramNode,
  handle: string | null | undefined,
  fieldOrderByNodeId: Record<string, string[]>
): number {
  const { width } = getNodeSize(node)
  if (handle === 'prev') {
    return node.position.x
  }
  if (handle === 'next') {
    return node.position.x + width
  }
  return orderedFieldCenterX(node, handle, fieldOrderByNodeId) ?? nodeCenterX(node)
}

function compactRow(items: RowItem[], gap: number): Map<string, number> {
  const layouts: RowLayoutItem[] = [...items]
    .sort(
      (a, b) =>
        a.desiredCenterX - b.desiredCenterX ||
        a.order - b.order ||
        (a.node.type ?? '').localeCompare(b.node.type ?? '') ||
        a.node.id.localeCompare(b.node.id)
    )
    .map((item) => {
      const { width } = getNodeSize(item.node)
      return {
        ...item,
        width,
        left: item.desiredCenterX - width / 2,
      }
    })

  for (let i = 1; i < layouts.length; i += 1) {
    const previous = layouts[i - 1]
    const item = layouts[i]
    item.left = Math.max(item.left, previous.left + previous.width + gap)
  }

  if (layouts.length > 1) {
    const desiredMin = Math.min(...layouts.map((item) => item.desiredCenterX - item.width / 2))
    const desiredMax = Math.max(...layouts.map((item) => item.desiredCenterX + item.width / 2))
    const placedMin = Math.min(...layouts.map((item) => item.left))
    const placedMax = Math.max(...layouts.map((item) => item.left + item.width))
    const shift = (desiredMin + desiredMax) / 2 - (placedMin + placedMax) / 2
    layouts.forEach((item) => {
      item.left += shift
    })
  }

  return new Map(layouts.map((item) => [item.node.id, item.left]))
}

export function arrangeNodes(nodes: DiagramNode[], edges: Edge[], options: ArrangeNodesOptions = {}): DiagramNode[] {
  if (!nodes.length) {
    return nodes
  }

  const sizedNodes = nodes.map(expandCodeNode)
  const flowConnectedNodeIds = new Set<string>()
  edges.forEach((edge) => {
    if (edge.sourceHandle === 'next') {
      flowConnectedNodeIds.add(edge.source)
    }
    if (edge.targetHandle === 'prev') {
      flowConnectedNodeIds.add(edge.target)
    }
  })
  const flowNodes = sizedNodes.filter(
    (node) =>
      isAlwaysFlowNode(node) || (node.type === 'app' && !isDataAppNode(node) && flowConnectedNodeIds.has(node.id))
  )
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
    nodesep: FLOW_NODE_SEPARATION,
    ranksep: FLOW_RANK_SEPARATION,
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
  const depthByAnchor = new Map<string, Map<string, number>>()

  const depthFor = (nodeId: string, anchorId: string): number => {
    const depths = depthByAnchor.get(anchorId)
    if (!depths) {
      return nodeId === anchorId ? 0 : 1
    }
    return nodeId === anchorId ? 0 : depths.get(nodeId) ?? 1
  }

  const desiredPlacement = (node: DiagramNode, anchorId: string, depth: number): { centerX: number; order: number } => {
    const candidates: { centerX: number; order: number; priority: number }[] = []
    const considerEdge = (edge: Edge, fixedNodeId: string, fixedHandle: string | null | undefined): void => {
      const fixedNode = positionedById[fixedNodeId] ?? nodesById[fixedNodeId]
      if (!fixedNode) {
        return
      }
      const fixedDepth = depthFor(fixedNodeId, anchorId)
      const priority = fixedDepth === depth - 1 ? 0 : fixedDepth < depth ? 1 : 2
      if (priority > 1) {
        return
      }
      candidates.push({
        centerX: handleCenterX(fixedNode, fixedHandle, fieldOrderByNodeId),
        order: handleOrderIndex(fixedNodeId, fixedHandle, fieldOrderByNodeId),
        priority,
      })
    }

    for (const edge of outgoingEdges[node.id] ?? []) {
      considerEdge(edge, edge.target, edge.targetHandle)
    }
    for (const edge of incomingEdges[node.id] ?? []) {
      considerEdge(edge, edge.source, edge.sourceHandle)
    }

    if (candidates.length === 0) {
      const anchorNode = positionedById[anchorId] ?? nodesById[anchorId]
      return {
        centerX: anchorNode ? nodeCenterX(anchorNode) : nodeCenterX(node),
        order: Number.MAX_SAFE_INTEGER,
      }
    }

    candidates.sort((a, b) => a.priority - b.priority || a.order - b.order || a.centerX - b.centerX)
    return { centerX: candidates[0].centerX, order: candidates[0].order }
  }

  Object.entries(nodesByAnchor).forEach(([anchorId, anchored]) => {
    const anchorNode = positionedById[anchorId] ?? nodesById[anchorId]
    if (!anchorNode) {
      return
    }

    const depthMap = new Map<string, number>()
    anchored.forEach((node) => {
      depthMap.set(node.id, Math.max(1, resolveDepth(node.id, anchorId)))
    })
    depthByAnchor.set(anchorId, depthMap)

    const maxDepth = Math.max(...depthMap.values(), 1)
    let rowBottom = anchorNode.position.y - ANCHOR_VERTICAL_GAP

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const rowNodes = anchored.filter((node) => depthMap.get(node.id) === depth)
      if (rowNodes.length === 0) {
        continue
      }

      const rowHeight = Math.max(...rowNodes.map((node) => getNodeSize(node).height))
      const rowTop = rowBottom - rowHeight
      const rowItems = rowNodes.map((node) => {
        const placement = desiredPlacement(node, anchorId, depth)
        return {
          node,
          desiredCenterX: placement.centerX,
          order: placement.order,
        }
      })
      const leftByNodeId = compactRow(rowItems, ANCHOR_HORIZONTAL_GAP)

      rowNodes.forEach((node) => {
        const size = getNodeSize(node)
        positionedById[node.id] = {
          ...node,
          position: {
            x: leftByNodeId.get(node.id) ?? nodeCenterX(anchorNode) - size.width / 2,
            y: rowTop + rowHeight - size.height,
          },
        }
      })

      rowBottom = rowTop - ANCHOR_VERTICAL_GAP
    }
  })

  const overlaps = (nodeA: DiagramNode, nodeB: DiagramNode, gapX: number, gapY: number): boolean => {
    const sizeA = getNodeSize(nodeA)
    const sizeB = getNodeSize(nodeB)
    return (
      nodeA.position.x < nodeB.position.x + sizeB.width + gapX &&
      nodeA.position.x + sizeA.width + gapX > nodeB.position.x &&
      nodeA.position.y < nodeB.position.y + sizeB.height + gapY &&
      nodeA.position.y + sizeA.height + gapY > nodeB.position.y
    )
  }

  const moveNode = (node: DiagramNode, position: { x: number; y: number }): void => {
    positionedById[node.id] = {
      ...node,
      position,
    }
  }

  const stateInputTargetByNodeId = new Map<string, string>()

  const placeStateInputsNearTargets = (): void => {
    stateInputTargetByNodeId.clear()

    const stateInputEdgesByTarget = edges.reduce((acc, edge) => {
      if (!edge.source || !edge.target || !edge.targetHandle?.startsWith('fieldInput/')) {
        return acc
      }
      const sourceNode = positionedById[edge.source] ?? nodesById[edge.source]
      const targetNode = positionedById[edge.target] ?? nodesById[edge.target]
      if (sourceNode?.type !== 'state' || !targetNode || !isStateInputTargetNode(targetNode)) {
        return acc
      }
      acc[edge.target] = [...(acc[edge.target] ?? []), edge]
      return acc
    }, {} as Record<string, Edge[]>)

    Object.entries(stateInputEdgesByTarget).forEach(([targetId, inputEdges]) => {
      const targetNode = positionedById[targetId] ?? nodesById[targetId]
      if (!targetNode) {
        return
      }

      const uniqueInputEdges = Array.from(
        inputEdges
          .sort(
            (a, b) =>
              handleOrderIndex(targetId, a.targetHandle, fieldOrderByNodeId) -
                handleOrderIndex(targetId, b.targetHandle, fieldOrderByNodeId) || a.source.localeCompare(b.source)
          )
          .reduce((acc, edge) => {
            if (!acc.has(edge.source)) {
              acc.set(edge.source, edge)
            }
            return acc
          }, new Map<string, Edge>())
          .values()
      )

      const rowItems = uniqueInputEdges
        .map((edge, index) => {
          const node = positionedById[edge.source] ?? nodesById[edge.source]
          if (!node) {
            return null
          }
          const size = getNodeSize(node)
          return {
            node,
            desiredCenterX:
              targetNode.position.x - STATE_INPUT_LEFT_OFFSET + STATE_INPUT_STAGGER_X * index + size.width / 2,
            order: index,
          }
        })
        .filter((item): item is RowItem => item !== null)

      if (rowItems.length === 0) {
        return
      }

      const rowHeight = Math.max(...rowItems.map((item) => getNodeSize(item.node).height))
      const rowTop = targetNode.position.y - STATE_INPUT_VERTICAL_GAP - rowHeight
      const leftByNodeId = compactRow(rowItems, STATE_INPUT_HORIZONTAL_GAP)

      rowItems.forEach((item) => {
        const size = getNodeSize(item.node)
        stateInputTargetByNodeId.set(item.node.id, targetId)
        moveNode(item.node, {
          x: leftByNodeId.get(item.node.id) ?? item.desiredCenterX - size.width / 2,
          y: rowTop + rowHeight - size.height,
        })
      })
    })
  }

  const resolveOverlaps = (): void => {
    const flowIds = sizedNodes
      .map((node) => node.id)
      .filter((nodeId) => flowNodeIds.has(nodeId))
      .sort((a, b) => {
        const nodeA = positionedById[a] ?? nodesById[a]
        const nodeB = positionedById[b] ?? nodesById[b]
        return nodeA.position.y - nodeB.position.y || nodeA.position.x - nodeB.position.x || a.localeCompare(b)
      })
    const nonFlowIds = sizedNodes
      .map((node) => node.id)
      .filter((nodeId) => !flowNodeIds.has(nodeId))
      .sort((a, b) => {
        const nodeA = positionedById[a] ?? nodesById[a]
        const nodeB = positionedById[b] ?? nodesById[b]
        return nodeA.position.y - nodeB.position.y || nodeA.position.x - nodeB.position.x || a.localeCompare(b)
      })

    for (let pass = 0; pass < COLLISION_PASSES; pass += 1) {
      let moved = false

      for (const nonFlowId of nonFlowIds) {
        const node = positionedById[nonFlowId] ?? nodesById[nonFlowId]
        const size = getNodeSize(node)
        for (const flowId of flowIds) {
          const flowNode = positionedById[flowId] ?? nodesById[flowId]
          const isTargetedStateInput = stateInputTargetByNodeId.has(node.id)
          const isOwnFlowTarget = stateInputTargetByNodeId.get(node.id) === flowId
          const gapX = isTargetedStateInput && !isOwnFlowTarget ? 0 : COLLISION_GAP_X
          const gapY = isTargetedStateInput && !isOwnFlowTarget ? 0 : COLLISION_GAP_Y
          if (!overlaps(node, flowNode, gapX, gapY)) {
            continue
          }
          const nextY = flowNode.position.y - size.height - COLLISION_GAP_Y
          if (nextY < node.position.y) {
            moveNode(node, { x: node.position.x, y: nextY })
            moved = true
          }
        }
      }

      for (let i = 0; i < nonFlowIds.length; i += 1) {
        for (let j = i + 1; j < nonFlowIds.length; j += 1) {
          const nodeA = positionedById[nonFlowIds[i]] ?? nodesById[nonFlowIds[i]]
          const nodeB = positionedById[nonFlowIds[j]] ?? nodesById[nonFlowIds[j]]
          if (!overlaps(nodeA, nodeB, COLLISION_GAP_X, COLLISION_GAP_Y)) {
            continue
          }

          const [fixedNode, movableNode] = nodeA.position.x <= nodeB.position.x ? [nodeA, nodeB] : [nodeB, nodeA]
          const fixedSize = getNodeSize(fixedNode)
          moveNode(movableNode, {
            x: fixedNode.position.x + fixedSize.width + COLLISION_GAP_X,
            y: movableNode.position.y,
          })
          moved = true
        }
      }
      if (!moved) {
        break
      }
    }
  }

  placeStateInputsNearTargets()
  resolveOverlaps()
  placeStateInputsNearTargets()
  resolveOverlaps()

  return sizedNodes.map((node) => positionedById[node.id] ?? node)
}
