import dagre from '@dagrejs/dagre'
import type { Edge } from '@reactflow/core/dist/esm/types/edges'
import type { CodeNodeData, DiagramNode } from '../types'

const FLOW_NODE_SEPARATION = 90
const FLOW_RANK_SEPARATION = 90
const FLOW_BRANCH_HORIZONTAL_GAP = 120
const ANCHOR_VERTICAL_GAP = 50
const ANCHOR_HORIZONTAL_GAP = 70
const FIELD_SLOT_PADDING_X = 44
const COLLISION_GAP_X = 40
const COLLISION_GAP_Y = 40
const COLLISION_PASSES = 24
const FLOW_GROUP_HORIZONTAL_GAP = 16
const FLOW_GROUP_VERTICAL_GAP = 0
const APP_INPUT_HORIZONTAL_GAP = COLLISION_GAP_X
const STATE_INPUT_LEFT_OFFSET = 32
const STATE_INPUT_STAGGER_X = 24
const STATE_INPUT_VERTICAL_GAP = COLLISION_GAP_Y
const STATE_INPUT_STACK_GAP = 16
const LOCAL_INPUT_LEFT_OFFSET = 35
const LOCAL_NARROW_TARGET_INPUT_LEFT_OFFSET = 64
const LOCAL_NARROW_TARGET_WIDTH = 340
const LOCAL_NARROW_TARGET_HEIGHT = 140
const LOCAL_STATE_INPUT_LEFT_OFFSET = 8
const LOCAL_DATA_INPUT_LEFT_OFFSET = 49
const LOCAL_INPUT_STAGGER_X = 16
const LOCAL_INPUT_VERTICAL_GAP = 50
const LOCAL_DATA_INPUT_VERTICAL_GAP = 38
const LOCAL_COMPACT_CODE_INPUT_VERTICAL_GAP = 30
const LOCAL_MEDIUM_CODE_INPUT_VERTICAL_GAP = 39
const LOCAL_NARROW_TARGET_CODE_INPUT_VERTICAL_GAP = 67
const LOCAL_STATE_INPUT_VERTICAL_GAP = 48
const LOCAL_STATE_INPUT_LARGE_TARGET_VERTICAL_GAP = 32
const LOCAL_LARGE_INPUT_TARGET_HEIGHT = 200
const LOCAL_INPUT_STACK_GAP = 18
const NODE_FALLBACK_WIDTH = 260
const NODE_FALLBACK_HEIGHT = 180
const CODE_NODE_MIN_WIDTH = 200
const CODE_NODE_MAX_AUTO_WIDTH = 340
const CODE_NODE_WIDE_MAX_AUTO_WIDTH = 2200
const CODE_NODE_WIDE_FIELD_THRESHOLD = 6
const CODE_NODE_MIN_HEIGHT = 119
const CODE_NODE_MAX_AUTO_HEIGHT = 260
const CODE_NODE_HORIZONTAL_CHROME = 100
const CODE_NODE_FIELD_HEADER_CHROME = 72
const CODE_NODE_FIELD_HEADER_GAP = 8
const CODE_NODE_HEADER_EXTRA_WIDTH = 120
const CODE_NODE_VERTICAL_CHROME = 91
const CODE_NODE_CHAR_WIDTH = 7
const CODE_NODE_LINE_HEIGHT = 22
const CODE_ARG_HORIZONTAL_PADDING = 40
const CODE_INPUTS_PER_ROW = 4
const CODE_INPUT_HORIZONTAL_GAP = ANCHOR_HORIZONTAL_GAP
const CODE_INPUT_VERTICAL_GAP = 60
const CODE_INPUT_ROW_GAP = 28
const FIELD_HANDLE_ORDER_SPAN = 1000

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

interface Bounds {
  left: number
  right: number
  top: number
  bottom: number
}

function getNodeSize(node: DiagramNode): { width: number; height: number } {
  return {
    width: node.width ?? NODE_FALLBACK_WIDTH,
    height: node.height ?? NODE_FALLBACK_HEIGHT,
  }
}

function numericDimension(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function getCodeNodeAutoSize(node: DiagramNode): { width: number; height: number } {
  const data = (node.data as CodeNodeData | undefined) ?? {}
  const codeArgs = data.codeArgs ?? []
  const codeOutputs = data.codeOutputs ?? []
  const code = (data.codeJS ?? data.code ?? '').trim()
  const lines = code ? code.split(/\r?\n/) : ['']
  const maxLineLength = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const fieldLabelWidth = [...codeArgs, ...codeOutputs].reduce(
    (max, field) => Math.max(max, field.name.length * CODE_NODE_CHAR_WIDTH + CODE_NODE_HORIZONTAL_CHROME),
    CODE_NODE_MIN_WIDTH
  )
  const codeInputHeaderWidth = codeArgs.reduce(
    (width, field) =>
      width + field.name.length * CODE_NODE_CHAR_WIDTH + CODE_NODE_FIELD_HEADER_CHROME + CODE_NODE_FIELD_HEADER_GAP,
    CODE_NODE_HEADER_EXTRA_WIDTH
  )
  const maxAutoWidth =
    codeArgs.length > CODE_NODE_WIDE_FIELD_THRESHOLD ? CODE_NODE_WIDE_MAX_AUTO_WIDTH : CODE_NODE_MAX_AUTO_WIDTH
  const width = Math.min(
    maxAutoWidth,
    Math.max(
      CODE_NODE_MIN_WIDTH,
      fieldLabelWidth,
      codeInputHeaderWidth,
      maxLineLength * CODE_NODE_CHAR_WIDTH + CODE_NODE_HORIZONTAL_CHROME
    )
  )
  const editorCharsPerLine = Math.max(1, Math.floor((width - CODE_NODE_HORIZONTAL_CHROME / 2) / CODE_NODE_CHAR_WIDTH))
  const visualLines = lines.reduce((count, line) => count + Math.max(1, Math.ceil(line.length / editorCharsPerLine)), 0)
  const height = Math.min(
    CODE_NODE_MAX_AUTO_HEIGHT,
    Math.max(CODE_NODE_MIN_HEIGHT, CODE_NODE_VERTICAL_CHROME + visualLines * CODE_NODE_LINE_HEIGHT)
  )
  return { width: Math.round(width), height: Math.round(height) }
}

function resizeCodeNodeForArrange(node: DiagramNode): DiagramNode {
  if (node.type !== 'code') {
    return node
  }
  const autoSize = getCodeNodeAutoSize(node)
  const currentWidth = numericDimension(node.width) ?? numericDimension(node.style?.width)
  const currentHeight = numericDimension(node.height) ?? numericDimension(node.style?.height)
  const width =
    currentWidth !== null && currentWidth > CODE_NODE_MAX_AUTO_WIDTH
      ? Math.max(currentWidth, autoSize.width)
      : autoSize.width
  const height =
    currentHeight !== null && currentHeight > CODE_NODE_MAX_AUTO_HEIGHT
      ? Math.max(currentHeight, autoSize.height)
      : autoSize.height
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

function baseFieldNameFromHandle(handle?: string | null): string | null {
  const fieldName = fieldNameFromHandle(handle)
  return fieldName?.replace(/\[.*$/, '') ?? null
}

function fieldPathOrderOffset(handle?: string | null): number | null {
  const fieldName = fieldNameFromHandle(handle)
  if (!fieldName) {
    return null
  }
  const matches = Array.from(fieldName.matchAll(/\[(\d+)\]/g))
  if (matches.length === 0) {
    return null
  }
  return matches.reduce((offset, match, index) => offset + Number(match[1]) / FIELD_HANDLE_ORDER_SPAN ** index, 0)
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

function shouldPlaceStateInputsNearTarget(node: DiagramNode, inputCount: number): boolean {
  if (node.type !== 'app') {
    return false
  }
  if (inputCount > 1) {
    return true
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

function nodeBounds(node: DiagramNode): Bounds {
  const size = getNodeSize(node)
  return {
    left: node.position.x,
    right: node.position.x + size.width,
    top: node.position.y,
    bottom: node.position.y + size.height,
  }
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
  const baseFieldName = baseFieldNameFromHandle(handle)
  const pathOffset = fieldPathOrderOffset(handle) ?? 0
  const exactIndex = fieldOrder.indexOf(fieldName)
  if (exactIndex >= 0) {
    return exactIndex * FIELD_HANDLE_ORDER_SPAN + pathOffset
  }
  const baseIndex = baseFieldName ? fieldOrder.indexOf(baseFieldName) : -1
  if (baseIndex >= 0) {
    return baseIndex * FIELD_HANDLE_ORDER_SPAN + pathOffset
  }
  const offset = fieldPathOrderOffset(handle)
  return offset !== null ? offset : Number.MAX_SAFE_INTEGER
}

function orderedFieldOffsetX(
  node: DiagramNode,
  handle: string | null | undefined,
  fieldOrderByNodeId: Record<string, string[]>
): number | null {
  const fieldName = fieldNameFromHandle(handle)
  if (!fieldName) {
    return null
  }

  const fieldOrder = fieldOrderByNodeId[node.id] ?? []
  const baseFieldName = baseFieldNameFromHandle(handle)
  const exactIndex = fieldOrder.indexOf(fieldName)
  const fieldIndex = exactIndex >= 0 ? exactIndex : baseFieldName ? fieldOrder.indexOf(baseFieldName) : -1
  if (fieldIndex < 0) {
    return null
  }

  const { width } = getNodeSize(node)
  const padding = handle?.startsWith('codeField/') ? CODE_ARG_HORIZONTAL_PADDING : FIELD_SLOT_PADDING_X
  const usableWidth = Math.max(width - padding * 2, 1)
  const denominator = Math.max(fieldOrder.length - 1, 1)
  return padding + (usableWidth * fieldIndex) / denominator
}

function orderedFieldCenterX(
  node: DiagramNode,
  handle: string | null | undefined,
  fieldOrderByNodeId: Record<string, string[]>
): number | null {
  const offset = orderedFieldOffsetX(node, handle, fieldOrderByNodeId)
  return offset === null ? null : node.position.x + offset
}

function handleOffsetX(
  node: DiagramNode,
  handle: string | null | undefined,
  fieldOrderByNodeId: Record<string, string[]>
): number {
  const { width } = getNodeSize(node)
  if (handle === 'prev') {
    return 0
  }
  if (handle === 'next') {
    return width
  }
  if (node.type === 'code' && handle === 'fieldOutput') {
    return CODE_ARG_HORIZONTAL_PADDING
  }
  return orderedFieldOffsetX(node, handle, fieldOrderByNodeId) ?? width / 2
}

function handleCenterX(
  node: DiagramNode,
  handle: string | null | undefined,
  fieldOrderByNodeId: Record<string, string[]>
): number {
  return node.position.x + handleOffsetX(node, handle, fieldOrderByNodeId)
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

  const fieldOrderByNodeId = options.fieldOrderByNodeId ?? {}
  const sizedNodes = nodes.map(resizeCodeNodeForArrange)
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
  const flowOrderByNodeId = new Map(flowNodes.map((node, index) => [node.id, index]))
  const orderedFlowEdges = [...flowEdges].sort(
    (a, b) =>
      (flowOrderByNodeId.get(a.source) ?? 0) - (flowOrderByNodeId.get(b.source) ?? 0) ||
      handleOrderIndex(a.source, a.sourceHandle, fieldOrderByNodeId) -
        handleOrderIndex(b.source, b.sourceHandle, fieldOrderByNodeId) ||
      handleOrderIndex(a.target, a.targetHandle, fieldOrderByNodeId) -
        handleOrderIndex(b.target, b.targetHandle, fieldOrderByNodeId) ||
      a.target.localeCompare(b.target)
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

  orderedFlowEdges.forEach((edge) => {
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

  const moveFlowSubtree = (nodeId: string, delta: { x: number; y: number }, visited: Set<string> = new Set()): void => {
    if (visited.has(nodeId)) {
      return
    }
    visited.add(nodeId)
    const position = basePositions.get(nodeId)
    if (position) {
      basePositions.set(nodeId, {
        x: position.x + delta.x,
        y: position.y + delta.y,
      })
    }
    orderedFlowEdges
      .filter((edge) => edge.source === nodeId)
      .forEach((edge) => {
        moveFlowSubtree(edge.target, delta, visited)
      })
  }

  const branchEdgesBySource = orderedFlowEdges.reduce((acc, edge) => {
    if (!edge.sourceHandle?.startsWith('field/') || edge.targetHandle !== 'prev') {
      return acc
    }
    acc[edge.source] = [...(acc[edge.source] ?? []), edge]
    return acc
  }, {} as Record<string, Edge[]>)

  Object.entries(branchEdgesBySource).forEach(([sourceId, sourceEdges]) => {
    if (sourceEdges.length < 2) {
      return
    }
    const sourceNode = flowNodes.find((node) => node.id === sourceId)
    const sourcePosition = basePositions.get(sourceId)
    if (!sourceNode || !sourcePosition) {
      return
    }

    let cursorY = sourcePosition.y + 24
    const branchGap = Math.max(FLOW_NODE_SEPARATION, getNodeSize(sourceNode).height)
    const visited = new Set<string>()
    sourceEdges.forEach((edge, index) => {
      const targetNode = flowNodes.find((node) => node.id === edge.target)
      const targetPosition = basePositions.get(edge.target)
      if (!targetNode || !targetPosition) {
        return
      }
      const desiredPosition = {
        x: sourcePosition.x + getNodeSize(sourceNode).width + FLOW_BRANCH_HORIZONTAL_GAP + index * FLOW_NODE_SEPARATION,
        y: cursorY,
      }
      moveFlowSubtree(
        edge.target,
        {
          x: desiredPosition.x - targetPosition.x,
          y: desiredPosition.y - targetPosition.y,
        },
        visited
      )
      cursorY += getNodeSize(targetNode).height + branchGap
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
  const edgeOrderByEdge = new WeakMap<Edge, number>()
  edges.forEach((edge, index) => {
    edgeOrderByEdge.set(edge, index)
  })

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

  const stackedStateInputTargets = (): Map<string, string> => {
    const stateInputEdgesByTarget = edges.reduce((acc, edge) => {
      if (!edge.source || !edge.target || !edge.targetHandle?.startsWith('fieldInput/')) {
        return acc
      }
      const sourceNode = nodesById[edge.source]
      const targetNode = nodesById[edge.target]
      if (sourceNode?.type !== 'state' || targetNode?.type !== 'app') {
        return acc
      }
      acc[edge.target] = [...(acc[edge.target] ?? []), edge]
      return acc
    }, {} as Record<string, Edge[]>)

    const targetByInputId = new Map<string, string>()
    Object.entries(stateInputEdgesByTarget).forEach(([targetId, inputEdges]) => {
      const targetNode = nodesById[targetId]
      const inputIds = new Set(inputEdges.map((edge) => edge.source))
      if (!targetNode || !shouldPlaceStateInputsNearTarget(targetNode, inputIds.size)) {
        return
      }
      inputIds.forEach((inputId) => {
        targetByInputId.set(inputId, targetId)
      })
    })
    return targetByInputId
  }

  const stackedStateInputTargetByNodeId = stackedStateInputTargets()
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
    const considerEdge = (
      edge: Edge,
      fixedNodeId: string,
      fixedHandle: string | null | undefined,
      movingHandle: string | null | undefined
    ): void => {
      const fixedNode = positionedById[fixedNodeId] ?? nodesById[fixedNodeId]
      if (!fixedNode) {
        return
      }
      const fixedDepth = depthFor(fixedNodeId, anchorId)
      const priority = fixedDepth === depth - 1 ? 0 : fixedDepth < depth ? 1 : 2
      if (priority > 1) {
        return
      }
      const { width } = getNodeSize(node)
      candidates.push({
        centerX:
          handleCenterX(fixedNode, fixedHandle, fieldOrderByNodeId) -
          handleOffsetX(node, movingHandle, fieldOrderByNodeId) +
          width / 2,
        order: handleOrderIndex(fixedNodeId, fixedHandle, fieldOrderByNodeId),
        priority,
      })
    }

    for (const edge of outgoingEdges[node.id] ?? []) {
      considerEdge(edge, edge.target, edge.targetHandle, edge.sourceHandle)
    }
    for (const edge of incomingEdges[node.id] ?? []) {
      considerEdge(edge, edge.source, edge.sourceHandle, edge.targetHandle)
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
      const rowNodes = anchored.filter(
        (node) => depthMap.get(node.id) === depth && !stackedStateInputTargetByNodeId.has(node.id)
      )
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

  const moveNodeIds = (nodeIds: Set<string>, delta: { x: number; y: number }): void => {
    nodeIds.forEach((nodeId) => {
      const node = positionedById[nodeId] ?? nodesById[nodeId]
      if (!node) {
        return
      }
      moveNode(node, {
        x: node.position.x + delta.x,
        y: node.position.y + delta.y,
      })
    })
  }

  const stateInputTargetByNodeId = new Map<string, string>()

  const isLocalInputEdge = (edge: Edge): boolean =>
    Boolean(
      edge.source &&
        edge.target &&
        !flowNodeIds.has(edge.source) &&
        (edge.targetHandle?.startsWith('fieldInput/') || edge.targetHandle?.startsWith('codeField/'))
    )

  const localInputEdgesByTarget = edges.reduce((acc, edge) => {
    if (!isLocalInputEdge(edge)) {
      return acc
    }
    acc[edge.target] = [...(acc[edge.target] ?? []), edge]
    return acc
  }, {} as Record<string, Edge[]>)

  const sortedUniqueLocalInputEdges = (targetId: string): Edge[] =>
    Array.from(
      (localInputEdgesByTarget[targetId] ?? [])
        .sort((a, b) => {
          return (
            handleOrderIndex(targetId, a.targetHandle, fieldOrderByNodeId) -
              handleOrderIndex(targetId, b.targetHandle, fieldOrderByNodeId) ||
            (edgeOrderByEdge.get(a) ?? 0) - (edgeOrderByEdge.get(b) ?? 0) ||
            a.source.localeCompare(b.source)
          )
        })
        .reduce((acc, edge) => {
          if (!acc.has(edge.source)) {
            acc.set(edge.source, edge)
          }
          return acc
        }, new Map<string, Edge>())
        .values()
    )

  const localInputLeftOffset = (sourceNode: DiagramNode, targetNode: DiagramNode): number => {
    if (sourceNode.type === 'state') {
      return LOCAL_STATE_INPUT_LEFT_OFFSET
    }
    if (isDataAppNode(sourceNode) && isDataAppNode(targetNode)) {
      return LOCAL_DATA_INPUT_LEFT_OFFSET
    }

    const targetSize = getNodeSize(targetNode)
    if (sourceNode.type === 'code' && targetSize.width <= LOCAL_NARROW_TARGET_WIDTH) {
      return LOCAL_NARROW_TARGET_INPUT_LEFT_OFFSET
    }
    return LOCAL_INPUT_LEFT_OFFSET
  }

  const localInputVerticalGap = (sourceNode: DiagramNode, targetNode: DiagramNode): number => {
    const targetSize = getNodeSize(targetNode)
    if (sourceNode.type === 'state') {
      return targetSize.height >= LOCAL_LARGE_INPUT_TARGET_HEIGHT
        ? LOCAL_STATE_INPUT_LARGE_TARGET_VERTICAL_GAP
        : LOCAL_STATE_INPUT_VERTICAL_GAP
    }
    if (isDataAppNode(sourceNode) && isDataAppNode(targetNode)) {
      return LOCAL_DATA_INPUT_VERTICAL_GAP
    }
    if (sourceNode.type === 'code') {
      if (targetSize.height <= LOCAL_NARROW_TARGET_HEIGHT) {
        return LOCAL_NARROW_TARGET_CODE_INPUT_VERTICAL_GAP
      }
      if (targetSize.height >= LOCAL_LARGE_INPUT_TARGET_HEIGHT) {
        return LOCAL_COMPACT_CODE_INPUT_VERTICAL_GAP
      }
      return LOCAL_MEDIUM_CODE_INPUT_VERTICAL_GAP
    }
    return LOCAL_INPUT_VERTICAL_GAP
  }

  const placeLocalInputTree = (targetId: string, visited: Set<string> = new Set()): void => {
    if (visited.has(targetId)) {
      return
    }
    visited.add(targetId)

    const targetNode = positionedById[targetId] ?? nodesById[targetId]
    if (!targetNode) {
      return
    }

    const inputEdges = sortedUniqueLocalInputEdges(targetId).filter((edge) => {
      const sourceNode = positionedById[edge.source] ?? nodesById[edge.source]
      return sourceNode && !flowNodeIds.has(sourceNode.id)
    })

    if (targetNode.type === 'code' && inputEdges.length > CODE_INPUTS_PER_ROW) {
      return
    }

    let stackBottom = targetNode.position.y

    inputEdges.forEach((edge, index) => {
      const sourceNode = positionedById[edge.source] ?? nodesById[edge.source]
      if (!sourceNode) {
        return
      }

      const sourceSize = getNodeSize(sourceNode)
      const verticalGap = localInputVerticalGap(sourceNode, targetNode)
      const leftOffset = localInputLeftOffset(sourceNode, targetNode)
      const stackTop = stackBottom - (index === 0 ? verticalGap : 0) - sourceSize.height

      moveNode(sourceNode, {
        x: targetNode.position.x - leftOffset - LOCAL_INPUT_STAGGER_X * index,
        y: stackTop,
      })
      stackBottom = stackTop - LOCAL_INPUT_STACK_GAP
      placeLocalInputTree(sourceNode.id, new Set(visited))
    })
  }

  const placeFlowInputTrees = (): void => {
    flowNodes
      .map((node) => positionedById[node.id] ?? node)
      .sort(
        (a, b) =>
          a.position.x - b.position.x ||
          a.position.y - b.position.y ||
          (flowOrderByNodeId.get(a.id) ?? 0) - (flowOrderByNodeId.get(b.id) ?? 0) ||
          a.id.localeCompare(b.id)
      )
      .forEach((node) => {
        placeLocalInputTree(node.id)
      })
  }

  const flowGroupNodeIdsByAnchor = (): Map<string, Set<string>> => {
    const groups = new Map<string, Set<string>>()
    flowNodes.forEach((node) => {
      groups.set(node.id, new Set([node.id]))
    })

    sizedNodes.forEach((node) => {
      if (flowNodeIds.has(node.id)) {
        return
      }
      const anchorId = resolveAnchor(node.id)
      if (!anchorId || !flowNodeIds.has(anchorId)) {
        return
      }
      const group = groups.get(anchorId) ?? new Set<string>()
      group.add(node.id)
      groups.set(anchorId, group)
    })

    return groups
  }

  const boundsOverlapVertically = (boundsA: Bounds, boundsB: Bounds): boolean =>
    boundsA.top < boundsB.bottom + FLOW_GROUP_VERTICAL_GAP && boundsA.bottom + FLOW_GROUP_VERTICAL_GAP > boundsB.top

  const requiredShiftForGroupOverlap = (currentNodeIds: Set<string>, placedNodeIds: Set<string>): number => {
    let shiftX = 0

    currentNodeIds.forEach((currentNodeId) => {
      const currentNode = positionedById[currentNodeId] ?? nodesById[currentNodeId]
      if (!currentNode) {
        return
      }
      const currentBounds = nodeBounds(currentNode)

      placedNodeIds.forEach((placedNodeId) => {
        const placedNode = positionedById[placedNodeId] ?? nodesById[placedNodeId]
        if (!placedNode) {
          return
        }
        const placedBounds = nodeBounds(placedNode)
        const overlapsHorizontally = currentBounds.left < placedBounds.right && currentBounds.right > placedBounds.left
        if (!overlapsHorizontally || !boundsOverlapVertically(currentBounds, placedBounds)) {
          return
        }
        shiftX = Math.max(shiftX, placedBounds.right + FLOW_GROUP_HORIZONTAL_GAP - currentBounds.left)
      })
    })

    return shiftX
  }

  const resolveFlowGroupOverlaps = (): void => {
    const groups = flowGroupNodeIdsByAnchor()
    const placedGroups: Array<{ nodeIds: Set<string> }> = []

    flowNodes
      .map((node) => positionedById[node.id] ?? node)
      .sort(
        (a, b) =>
          a.position.x - b.position.x ||
          a.position.y - b.position.y ||
          (flowOrderByNodeId.get(a.id) ?? 0) - (flowOrderByNodeId.get(b.id) ?? 0) ||
          a.id.localeCompare(b.id)
      )
      .forEach((flowNode) => {
        const nodeIds = groups.get(flowNode.id) ?? new Set([flowNode.id])

        for (let pass = 0; pass < COLLISION_PASSES; pass += 1) {
          const shiftX = placedGroups.reduce(
            (shift, placedGroup) => Math.max(shift, requiredShiftForGroupOverlap(nodeIds, placedGroup.nodeIds)),
            0
          )
          if (shiftX <= 0) {
            break
          }
          moveNodeIds(nodeIds, { x: shiftX, y: 0 })
        }

        placedGroups.push({ nodeIds })
      })
  }

  const placeCodeInputsNearTargets = (): void => {
    const codeInputEdgesByTarget = edges.reduce((acc, edge) => {
      if (!edge.source || !edge.target || !edge.targetHandle?.startsWith('codeField/')) {
        return acc
      }
      const sourceNode = positionedById[edge.source] ?? nodesById[edge.source]
      const targetNode = positionedById[edge.target] ?? nodesById[edge.target]
      if (!sourceNode || targetNode?.type !== 'code' || flowNodeIds.has(sourceNode.id)) {
        return acc
      }
      acc[edge.target] = [...(acc[edge.target] ?? []), edge]
      return acc
    }, {} as Record<string, Edge[]>)

    Object.entries(codeInputEdgesByTarget).forEach(([targetId, inputEdges]) => {
      if (inputEdges.length <= CODE_INPUTS_PER_ROW) {
        return
      }
      const targetNode = positionedById[targetId] ?? nodesById[targetId]
      if (!targetNode) {
        return
      }

      const uniqueInputEdges = Array.from(
        inputEdges
          .sort(
            (a, b) =>
              handleOrderIndex(targetId, a.targetHandle, fieldOrderByNodeId) -
                handleOrderIndex(targetId, b.targetHandle, fieldOrderByNodeId) ||
              (edgeOrderByEdge.get(a) ?? 0) - (edgeOrderByEdge.get(b) ?? 0) ||
              a.source.localeCompare(b.source)
          )
          .reduce((acc, edge) => {
            if (!acc.has(edge.source)) {
              acc.set(edge.source, edge)
            }
            return acc
          }, new Map<string, Edge>())
          .values()
      )

      const stateInputEdges = uniqueInputEdges.filter((edge) => {
        const sourceNode = positionedById[edge.source] ?? nodesById[edge.source]
        return sourceNode?.type === 'state'
      })
      const otherInputEdges = uniqueInputEdges.filter((edge) => {
        const sourceNode = positionedById[edge.source] ?? nodesById[edge.source]
        return sourceNode?.type !== 'state'
      })
      const rowEdgeGroups: Edge[][] = []
      for (let start = 0; start < stateInputEdges.length; start += CODE_INPUTS_PER_ROW) {
        rowEdgeGroups.push(stateInputEdges.slice(start, start + CODE_INPUTS_PER_ROW))
      }
      for (let start = 0; start < otherInputEdges.length; start += CODE_INPUTS_PER_ROW) {
        rowEdgeGroups.push(otherInputEdges.slice(start, start + CODE_INPUTS_PER_ROW))
      }

      let rowBottom = targetNode.position.y - CODE_INPUT_VERTICAL_GAP
      for (const [rowIndex, rowEdges] of rowEdgeGroups.entries()) {
        const rowItems = rowEdges
          .map((edge, index) => {
            const node = positionedById[edge.source] ?? nodesById[edge.source]
            if (!node) {
              return null
            }
            return {
              node,
              desiredCenterX: handleCenterX(targetNode, edge.targetHandle, fieldOrderByNodeId),
              order: rowIndex * CODE_INPUTS_PER_ROW + index,
            }
          })
          .filter((item): item is RowItem => item !== null)

        if (rowItems.length === 0) {
          continue
        }

        const rowHeight = Math.max(...rowItems.map((item) => getNodeSize(item.node).height))
        const rowTop = rowBottom - rowHeight
        const leftByNodeId = compactRow(rowItems, CODE_INPUT_HORIZONTAL_GAP)
        rowItems.forEach((item) => {
          const size = getNodeSize(item.node)
          moveNode(item.node, {
            x: leftByNodeId.get(item.node.id) ?? item.desiredCenterX - size.width / 2,
            y: rowTop + rowHeight - size.height,
          })
        })
        rowBottom = rowTop - CODE_INPUT_ROW_GAP
      }
    })
  }

  const placeAppInputsBesideTargets = (): void => {
    const appInputEdges = edges
      .filter((edge) => {
        const sourceNode = positionedById[edge.source] ?? nodesById[edge.source]
        const targetNode = positionedById[edge.target] ?? nodesById[edge.target]
        return (
          sourceNode &&
          targetNode &&
          isDataAppNode(sourceNode) &&
          targetNode.type === 'app' &&
          !isDataAppNode(targetNode) &&
          !flowNodeIds.has(sourceNode.id) &&
          !flowNodeIds.has(targetNode.id) &&
          edge.sourceHandle === 'fieldOutput' &&
          Boolean(edge.targetHandle?.startsWith('fieldInput/'))
        )
      })
      .sort((a, b) => {
        const anchorA = resolveAnchor(a.source)
        const anchorB = resolveAnchor(b.source)
        const depthA = anchorA ? depthFor(a.source, anchorA) : 0
        const depthB = anchorB ? depthFor(b.source, anchorB) : 0
        return depthA - depthB || a.source.localeCompare(b.source)
      })

    appInputEdges.forEach((edge) => {
      const sourceNode = positionedById[edge.source] ?? nodesById[edge.source]
      const targetNode = positionedById[edge.target] ?? nodesById[edge.target]
      if (!sourceNode || !targetNode) {
        return
      }

      const sourceSize = getNodeSize(sourceNode)
      const targetSize = getNodeSize(targetNode)
      moveNode(sourceNode, {
        x: targetNode.position.x - sourceSize.width - APP_INPUT_HORIZONTAL_GAP,
        y: targetNode.position.y + (targetSize.height - sourceSize.height) / 2,
      })
    })
  }

  const placeStateInputsNearTargets = (): void => {
    stateInputTargetByNodeId.clear()

    const stateInputEdgesByTarget = edges.reduce((acc, edge) => {
      if (!edge.source || !edge.target || !edge.targetHandle?.startsWith('fieldInput/')) {
        return acc
      }
      const sourceNode = positionedById[edge.source] ?? nodesById[edge.source]
      const targetNode = positionedById[edge.target] ?? nodesById[edge.target]
      if (sourceNode?.type !== 'state' || targetNode?.type !== 'app') {
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
                handleOrderIndex(targetId, b.targetHandle, fieldOrderByNodeId) ||
              (edgeOrderByEdge.get(a) ?? 0) - (edgeOrderByEdge.get(b) ?? 0) ||
              a.source.localeCompare(b.source)
          )
          .reduce((acc, edge) => {
            if (!acc.has(edge.source)) {
              acc.set(edge.source, edge)
            }
            return acc
          }, new Map<string, Edge>())
          .values()
      )

      const inputNodes = uniqueInputEdges
        .map((edge) => positionedById[edge.source] ?? nodesById[edge.source])
        .filter((node): node is DiagramNode => Boolean(node))

      if (inputNodes.length === 0) {
        return
      }
      if (!shouldPlaceStateInputsNearTarget(targetNode, inputNodes.length)) {
        return
      }

      let stackBottom = targetNode.position.y - STATE_INPUT_VERTICAL_GAP

      inputNodes.forEach((node, index) => {
        const size = getNodeSize(node)
        const stackTop = stackBottom - size.height
        stateInputTargetByNodeId.set(node.id, targetId)
        moveNode(node, {
          x: targetNode.position.x - STATE_INPUT_LEFT_OFFSET - STATE_INPUT_STAGGER_X * index,
          y: stackTop,
        })
        stackBottom = stackTop - STATE_INPUT_STACK_GAP
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
          const targetA = stateInputTargetByNodeId.get(nodeA.id)
          const targetB = stateInputTargetByNodeId.get(nodeB.id)
          const sameStateInputTarget = targetA && targetA === targetB
          const connectedStateInputTarget = targetA === nodeB.id || targetB === nodeA.id
          const sameStateInputStack = sameStateInputTarget || connectedStateInputTarget
          const gapX = sameStateInputStack ? 0 : COLLISION_GAP_X
          const gapY = sameStateInputStack ? 0 : COLLISION_GAP_Y
          if (!overlaps(nodeA, nodeB, gapX, gapY)) {
            continue
          }

          const nodeAIsStackedStateInput = stateInputTargetByNodeId.has(nodeA.id)
          const nodeBIsStackedStateInput = stateInputTargetByNodeId.has(nodeB.id)
          const [fixedNode, movableNode] =
            nodeAIsStackedStateInput !== nodeBIsStackedStateInput
              ? nodeAIsStackedStateInput
                ? [nodeA, nodeB]
                : [nodeB, nodeA]
              : nodeA.position.x <= nodeB.position.x
              ? [nodeA, nodeB]
              : [nodeB, nodeA]
          const fixedSize = getNodeSize(fixedNode)
          const movableSize = getNodeSize(movableNode)
          const nextX =
            movableNode.position.x < fixedNode.position.x
              ? fixedNode.position.x - movableSize.width - COLLISION_GAP_X
              : fixedNode.position.x + fixedSize.width + COLLISION_GAP_X
          moveNode(movableNode, {
            x: nextX,
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

  placeAppInputsBesideTargets()
  placeCodeInputsNearTargets()
  placeStateInputsNearTargets()
  resolveOverlaps()
  placeAppInputsBesideTargets()
  placeCodeInputsNearTargets()
  placeStateInputsNearTargets()
  resolveOverlaps()
  placeCodeInputsNearTargets()
  placeStateInputsNearTargets()
  placeFlowInputTrees()
  placeAppInputsBesideTargets()
  placeStateInputsNearTargets()
  placeCodeInputsNearTargets()
  resolveFlowGroupOverlaps()

  return sizedNodes.map((node) => positionedById[node.id] ?? node)
}
