import type { StateField } from '../types'

export type SplitLayoutDirection = 'row' | 'column'

export interface SplitLayoutLeaf {
  id: string
  type: 'leaf'
  sceneId?: string | null
  state?: Record<string, any>
}

export interface SplitLayoutBranch {
  id: string
  type: 'split'
  direction: SplitLayoutDirection
  ratios: number[]
  children: SplitLayoutNode[]
}

export type SplitLayoutNode = SplitLayoutLeaf | SplitLayoutBranch

export interface SplitScreenBackground {
  color: string
  sceneId?: string | null
  opacity: number
}

export interface SplitScreenSceneLayout {
  name: string
  borderWidth: number
  outerBorderWidth: number
  background: SplitScreenBackground
  root: SplitLayoutBranch
}

export interface SplitLayoutPreset {
  id: string
  name: string
  root: SplitLayoutBranch
}

export interface SplitLayoutLeafRect {
  leafId: string
  sceneId?: string | null
  x: number
  y: number
  width: number
  height: number
}

export interface SplitLayoutDivider {
  parentId: string
  index: number
  orientation: 'vertical' | 'horizontal'
  x: number
  y: number
  width: number
  height: number
  parentX: number
  parentY: number
  parentWidth: number
  parentHeight: number
}

export interface SplitLayoutLeafBorderEdges {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

const MIN_RATIO = 0.15
const EDGE_EPSILON = 0.001

export const defaultSplitScreenBackground: SplitScreenBackground = {
  color: '#f8fafc',
  sceneId: null,
  opacity: 1,
}

function leaf(id: string): SplitLayoutLeaf {
  return { id, type: 'leaf', sceneId: null, state: {} }
}

function split(
  id: string,
  direction: SplitLayoutDirection,
  ratios: number[],
  children: SplitLayoutNode[]
): SplitLayoutBranch {
  return { id, type: 'split', direction, ratios, children }
}

export const splitScreenLayoutPresets: SplitLayoutPreset[] = [
  {
    id: 'two-columns',
    name: '2',
    root: split('two-columns/root', 'row', [1, 1], [leaf('two-columns/a'), leaf('two-columns/b')]),
  },
  {
    id: 'three-columns',
    name: '3',
    root: split(
      'three-columns/root',
      'row',
      [1, 1, 1],
      [leaf('three-columns/a'), leaf('three-columns/b'), leaf('three-columns/c')]
    ),
  },
  {
    id: 'left-plus-two',
    name: '1 + 2',
    root: split(
      'left-plus-two/root',
      'row',
      [1.45, 1],
      [
        leaf('left-plus-two/a'),
        split('left-plus-two/right', 'column', [1, 1], [leaf('left-plus-two/b'), leaf('left-plus-two/c')]),
      ]
    ),
  },
  {
    id: 'grid-four',
    name: '2 x 2',
    root: split(
      'grid-four/root',
      'column',
      [1, 1],
      [
        split('grid-four/top', 'row', [1, 1], [leaf('grid-four/a'), leaf('grid-four/b')]),
        split('grid-four/bottom', 'row', [1, 1], [leaf('grid-four/c'), leaf('grid-four/d')]),
      ]
    ),
  },
  {
    id: 'three-plus-two',
    name: '3 + 2',
    root: split(
      'three-plus-two/root',
      'column',
      [1, 1],
      [
        split(
          'three-plus-two/top',
          'row',
          [1, 1, 1],
          [leaf('three-plus-two/a'), leaf('three-plus-two/b'), leaf('three-plus-two/c')]
        ),
        split('three-plus-two/bottom', 'row', [1, 1], [leaf('three-plus-two/d'), leaf('three-plus-two/e')]),
      ]
    ),
  },
  {
    id: 'four-columns',
    name: '4',
    root: split(
      'four-columns/root',
      'row',
      [1, 1, 1, 1],
      [leaf('four-columns/a'), leaf('four-columns/b'), leaf('four-columns/c'), leaf('four-columns/d')]
    ),
  },
  {
    id: 'one-plus-three',
    name: '1 + 3',
    root: split(
      'one-plus-three/root',
      'row',
      [1.55, 1],
      [
        leaf('one-plus-three/a'),
        split(
          'one-plus-three/right',
          'column',
          [1, 1, 1],
          [leaf('one-plus-three/b'), leaf('one-plus-three/c'), leaf('one-plus-three/d')]
        ),
      ]
    ),
  },
  {
    id: 'one-plus-four',
    name: '1 + 4',
    root: split(
      'one-plus-four/root',
      'row',
      [1.55, 1],
      [
        leaf('one-plus-four/a'),
        split(
          'one-plus-four/right',
          'column',
          [1, 1],
          [
            split('one-plus-four/right-top', 'row', [1, 1], [leaf('one-plus-four/b'), leaf('one-plus-four/c')]),
            split('one-plus-four/right-bottom', 'row', [1, 1], [leaf('one-plus-four/d'), leaf('one-plus-four/e')]),
          ]
        ),
      ]
    ),
  },
]

export function cloneSplitLayoutNode<T extends SplitLayoutNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T
}

export function rotateSplitLayoutNode<T extends SplitLayoutNode>(node: T): T {
  if (node.type === 'leaf') {
    return { ...node } as T
  }

  const rotatedChildren = node.children.map((child) => rotateSplitLayoutNode(child))
  const rotatedRatios = [...node.ratios]
  const reverseOrder = node.direction === 'column'

  return {
    ...node,
    direction: node.direction === 'row' ? 'column' : 'row',
    ratios: reverseOrder ? rotatedRatios.reverse() : rotatedRatios,
    children: reverseOrder ? rotatedChildren.reverse() : rotatedChildren,
  } as T
}

export function cloneSplitScreenSceneLayout(layout: SplitScreenSceneLayout): SplitScreenSceneLayout {
  const outerBorderWidth = layout.outerBorderWidth ?? ((layout as any).outerBorder ? layout.borderWidth : 0)
  return {
    name: layout.name || 'Split screen',
    borderWidth: Math.max(0, Math.min(48, Math.round(Number(layout.borderWidth) || 0))),
    outerBorderWidth: Math.max(0, Math.min(48, Math.round(Number(outerBorderWidth) || 0))),
    background: {
      color: layout.background?.color || defaultSplitScreenBackground.color,
      sceneId: layout.background?.sceneId || null,
      opacity: Math.max(
        0,
        Math.min(1, Number(layout.background?.opacity ?? defaultSplitScreenBackground.opacity) || 0)
      ),
    },
    root: cloneSplitLayoutNode(layout.root),
  }
}

function normalizedLeafState(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => key))
}

function normalizeSplitLayoutNode(value: any): SplitLayoutNode | null {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') {
    return null
  }

  if (value.type === 'leaf') {
    return {
      id: value.id,
      type: 'leaf',
      sceneId: typeof value.sceneId === 'string' ? value.sceneId : null,
      state: normalizedLeafState(value.state),
    }
  }

  if (value.type !== 'split' || (value.direction !== 'row' && value.direction !== 'column')) {
    return null
  }

  const sourceChildren: any[] = Array.isArray(value.children) ? value.children : []
  const children = sourceChildren
    .map(normalizeSplitLayoutNode)
    .filter((child: SplitLayoutNode | null): child is SplitLayoutNode => Boolean(child))
  if (children.length === 0) {
    return null
  }

  const sourceRatios: any[] = Array.isArray(value.ratios) ? value.ratios : []
  const ratios = children.map((_child: SplitLayoutNode, index: number) => {
    const ratio = Number(sourceRatios[index])
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  })

  return {
    id: value.id,
    type: 'split',
    direction: value.direction,
    ratios,
    children,
  }
}

export function normalizeSplitScreenSceneLayout(value: any): SplitScreenSceneLayout | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const root = normalizeSplitLayoutNode(value.root)
  if (!root || root.type !== 'split') {
    return null
  }

  return {
    name: typeof value.name === 'string' && value.name.trim() ? value.name : 'Split screen',
    borderWidth: Math.max(0, Math.min(48, Math.round(Number(value.borderWidth) || 0))),
    outerBorderWidth: Math.max(
      0,
      Math.min(48, Math.round(Number(value.outerBorderWidth ?? (value.outerBorder ? value.borderWidth : 0)) || 0))
    ),
    background: {
      color: typeof value.background?.color === 'string' ? value.background.color : defaultSplitScreenBackground.color,
      sceneId: typeof value.background?.sceneId === 'string' ? value.background.sceneId : null,
      opacity: Math.max(0, Math.min(1, Number(value.background?.opacity ?? defaultSplitScreenBackground.opacity) || 0)),
    },
    root,
  }
}

export function defaultSplitScreenSceneLayout(): SplitScreenSceneLayout {
  return {
    name: 'Split screen',
    borderWidth: 0,
    outerBorderWidth: 0,
    background: { ...defaultSplitScreenBackground },
    root: cloneSplitLayoutNode(splitScreenLayoutPresets[0].root),
  }
}

export function splitLayoutPresetById(presetId: string): SplitLayoutPreset {
  return splitScreenLayoutPresets.find((preset) => preset.id === presetId) ?? splitScreenLayoutPresets[0]
}

function normalizeRatios(ratios: number[], expectedLength: number): number[] {
  const normalized = Array.from({ length: expectedLength }, (_, index) => {
    const ratio = Number(ratios[index])
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  })
  return normalized.every((ratio) => ratio <= 0) ? normalized.map(() => 1) : normalized
}

function mapSplitLayoutNode(
  node: SplitLayoutNode,
  mapper: (node: SplitLayoutNode) => SplitLayoutNode
): SplitLayoutNode {
  const mapped = mapper(node)
  if (mapped.type === 'leaf') {
    return mapped
  }
  return {
    ...mapped,
    ratios: normalizeRatios(mapped.ratios, mapped.children.length),
    children: mapped.children.map((child) => mapSplitLayoutNode(child, mapper)),
  }
}

export function assignSceneToSplitLayoutLeaf(
  root: SplitLayoutBranch,
  leafId: string,
  sceneId: string | null
): SplitLayoutBranch {
  return mapSplitLayoutNode(root, (node) => {
    if (node.type !== 'leaf' || node.id !== leafId) {
      return node
    }
    return {
      ...node,
      sceneId,
      state: node.sceneId === sceneId ? node.state ?? {} : {},
    }
  }) as SplitLayoutBranch
}

function normalizeSceneStateValue(field: StateField, value: any): any {
  if (value === null || value === undefined) {
    return undefined
  }
  if (field.type === 'boolean') {
    if (value === '') {
      return undefined
    }
    return value === true || value === 'true'
  }
  if (field.type === 'integer') {
    const parsed = parseInt(String(value), 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (field.type === 'float') {
    const parsed = parseFloat(String(value))
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value === 'string') {
    return value
  }
  return value
}

function stateValuesMatch(first: any, second: any): boolean {
  if ((first === '' && second === undefined) || (first === undefined && second === '')) {
    return true
  }
  return JSON.stringify(first ?? null) === JSON.stringify(second ?? null)
}

export function setSplitLayoutLeafStateValue(
  root: SplitLayoutBranch,
  leafId: string,
  field: StateField,
  value: any
): SplitLayoutBranch {
  return mapSplitLayoutNode(root, (node) => {
    if (node.type !== 'leaf' || node.id !== leafId) {
      return node
    }
    const nextState = { ...(node.state ?? {}) }
    const normalizedValue = normalizeSceneStateValue(field, value)
    const normalizedDefault = normalizeSceneStateValue(field, field.value)
    if (normalizedValue === undefined || stateValuesMatch(normalizedValue, normalizedDefault)) {
      delete nextState[field.name]
    } else {
      nextState[field.name] = normalizedValue
    }
    return { ...node, state: nextState }
  }) as SplitLayoutBranch
}

export function updateSplitLayoutAdjacentRatio(
  root: SplitLayoutBranch,
  parentId: string,
  index: number,
  positionRatio: number
): SplitLayoutBranch {
  return mapSplitLayoutNode(root, (node) => {
    if (node.type !== 'split' || node.id !== parentId || index < 0 || index >= node.children.length - 1) {
      return node
    }

    const ratios = normalizeRatios(node.ratios, node.children.length)
    const total = ratios.reduce((sum, ratio) => sum + ratio, 0)
    const before = ratios.slice(0, index).reduce((sum, ratio) => sum + ratio, 0)
    const pair = ratios[index] + ratios[index + 1]
    const position = Math.max(0, Math.min(1, positionRatio)) * total
    const minPairRatio = Math.min(pair / 2, Math.max(MIN_RATIO, pair * 0.08))
    const nextFirst = Math.max(minPairRatio, Math.min(pair - minPairRatio, position - before))
    const nextRatios = [...ratios]
    nextRatios[index] = nextFirst
    nextRatios[index + 1] = pair - nextFirst
    return { ...node, ratios: nextRatios }
  }) as SplitLayoutBranch
}

export function splitLayoutLeaves(node: SplitLayoutNode): SplitLayoutLeaf[] {
  if (node.type === 'leaf') {
    return [node]
  }
  return node.children.flatMap(splitLayoutLeaves)
}

export function configuredSplitLayoutLeafCount(node: SplitLayoutNode): number {
  return splitLayoutLeaves(node).filter((leaf) => Boolean(leaf.sceneId)).length
}

export function splitLayoutLeafRects(root: SplitLayoutNode): SplitLayoutLeafRect[] {
  const rects: SplitLayoutLeafRect[] = []

  const visit = (node: SplitLayoutNode, x: number, y: number, width: number, height: number): void => {
    if (node.type === 'leaf') {
      rects.push({ leafId: node.id, sceneId: node.sceneId, x, y, width, height })
      return
    }

    const ratios = normalizeRatios(node.ratios, node.children.length)
    const total = ratios.reduce((sum, ratio) => sum + ratio, 0) || 1
    let offset = 0

    node.children.forEach((child, index) => {
      const share = ratios[index] / total
      if (node.direction === 'row') {
        const childWidth = width * share
        visit(child, x + offset, y, childWidth, height)
        offset += childWidth
      } else {
        const childHeight = height * share
        visit(child, x, y + offset, width, childHeight)
        offset += childHeight
      }
    })
  }

  visit(root, 0, 0, 100, 100)
  return rects
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return Math.min(endA, endB) - Math.max(startA, startB) > EDGE_EPSILON
}

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= EDGE_EPSILON
}

export function splitLayoutLeafBorderEdges(rects: SplitLayoutLeafRect[]): Map<string, SplitLayoutLeafBorderEdges> {
  const edges = new Map<string, SplitLayoutLeafBorderEdges>()

  for (const rect of rects) {
    const rectRight = rect.x + rect.width
    const rectBottom = rect.y + rect.height
    const nextEdges: SplitLayoutLeafBorderEdges = {
      top: false,
      right: false,
      bottom: false,
      left: false,
    }

    for (const other of rects) {
      if (other.leafId === rect.leafId) {
        continue
      }
      const otherRight = other.x + other.width
      const otherBottom = other.y + other.height
      const verticalOverlap = rangesOverlap(rect.y, rectBottom, other.y, otherBottom)
      const horizontalOverlap = rangesOverlap(rect.x, rectRight, other.x, otherRight)

      if (verticalOverlap && closeEnough(rect.x, otherRight)) {
        nextEdges.left = true
      }
      if (verticalOverlap && closeEnough(rectRight, other.x)) {
        nextEdges.right = true
      }
      if (horizontalOverlap && closeEnough(rect.y, otherBottom)) {
        nextEdges.top = true
      }
      if (horizontalOverlap && closeEnough(rectBottom, other.y)) {
        nextEdges.bottom = true
      }
    }

    edges.set(rect.leafId, nextEdges)
  }

  return edges
}

export function splitLayoutOuterBorderEdges(rect: SplitLayoutLeafRect): SplitLayoutLeafBorderEdges {
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  return {
    top: closeEnough(rect.y, 0),
    right: closeEnough(right, 100),
    bottom: closeEnough(bottom, 100),
    left: closeEnough(rect.x, 0),
  }
}

export function splitLayoutDividers(root: SplitLayoutNode): SplitLayoutDivider[] {
  const dividers: SplitLayoutDivider[] = []

  const visit = (node: SplitLayoutNode, x: number, y: number, width: number, height: number): void => {
    if (node.type === 'leaf') {
      return
    }

    const ratios = normalizeRatios(node.ratios, node.children.length)
    const total = ratios.reduce((sum, ratio) => sum + ratio, 0) || 1
    let offset = 0

    node.children.forEach((child, index) => {
      const share = ratios[index] / total
      if (node.direction === 'row') {
        const childWidth = width * share
        visit(child, x + offset, y, childWidth, height)
        offset += childWidth
        if (index < node.children.length - 1) {
          dividers.push({
            parentId: node.id,
            index,
            orientation: 'vertical',
            x: x + offset,
            y,
            width: 0,
            height,
            parentX: x,
            parentY: y,
            parentWidth: width,
            parentHeight: height,
          })
        }
      } else {
        const childHeight = height * share
        visit(child, x, y + offset, width, childHeight)
        offset += childHeight
        if (index < node.children.length - 1) {
          dividers.push({
            parentId: node.id,
            index,
            orientation: 'horizontal',
            x,
            y: y + offset,
            width,
            height: 0,
            parentX: x,
            parentY: y,
            parentWidth: width,
            parentHeight: height,
          })
        }
      }
    })
  }

  visit(root, 0, 0, 100, 100)
  return dividers
}
