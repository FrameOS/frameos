export type SplitLayoutDirection = 'row' | 'column'

export interface SplitLayoutLeaf {
  id: string
  type: 'leaf'
  sceneId?: string | null
}

export interface SplitLayoutBranch {
  id: string
  type: 'split'
  direction: SplitLayoutDirection
  ratios: number[]
  children: SplitLayoutNode[]
}

export type SplitLayoutNode = SplitLayoutLeaf | SplitLayoutBranch

export interface SplitScreenSceneLayout {
  name: string
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

const MIN_RATIO = 0.15

function leaf(id: string): SplitLayoutLeaf {
  return { id, type: 'leaf', sceneId: null }
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
    name: '2 vertical',
    root: split('two-columns/root', 'row', [1, 1], [leaf('two-columns/a'), leaf('two-columns/b')]),
  },
  {
    id: 'two-rows',
    name: '2 horizontal',
    root: split('two-rows/root', 'column', [1, 1], [leaf('two-rows/a'), leaf('two-rows/b')]),
  },
  {
    id: 'three-columns',
    name: '3 vertical',
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
    id: 'two-plus-right',
    name: '2 + 1',
    root: split(
      'two-plus-right/root',
      'row',
      [1, 1.45],
      [
        split('two-plus-right/left', 'column', [1, 1], [leaf('two-plus-right/a'), leaf('two-plus-right/b')]),
        leaf('two-plus-right/c'),
      ]
    ),
  },
  {
    id: 'top-plus-two',
    name: '1 over 2',
    root: split(
      'top-plus-two/root',
      'column',
      [1.35, 1],
      [
        leaf('top-plus-two/a'),
        split('top-plus-two/bottom', 'row', [1, 1], [leaf('top-plus-two/b'), leaf('top-plus-two/c')]),
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
    name: '4 vertical',
    root: split(
      'four-columns/root',
      'row',
      [1, 1, 1, 1],
      [leaf('four-columns/a'), leaf('four-columns/b'), leaf('four-columns/c'), leaf('four-columns/d')]
    ),
  },
  {
    id: 'four-rows',
    name: '4 horizontal',
    root: split(
      'four-rows/root',
      'column',
      [1, 1, 1, 1],
      [leaf('four-rows/a'), leaf('four-rows/b'), leaf('four-rows/c'), leaf('four-rows/d')]
    ),
  },
  {
    id: 'two-over-one',
    name: '2 over 1',
    root: split(
      'two-over-one/root',
      'column',
      [1, 1.25],
      [
        split('two-over-one/top', 'row', [1, 1], [leaf('two-over-one/a'), leaf('two-over-one/b')]),
        leaf('two-over-one/c'),
      ]
    ),
  },
  {
    id: 'three-over-one',
    name: '3 over 1',
    root: split(
      'three-over-one/root',
      'column',
      [1, 1.25],
      [
        split(
          'three-over-one/top',
          'row',
          [1, 1, 1],
          [leaf('three-over-one/a'), leaf('three-over-one/b'), leaf('three-over-one/c')]
        ),
        leaf('three-over-one/d'),
      ]
    ),
  },
  {
    id: 'one-over-three',
    name: '1 over 3',
    root: split(
      'one-over-three/root',
      'column',
      [1.25, 1],
      [
        leaf('one-over-three/a'),
        split(
          'one-over-three/bottom',
          'row',
          [1, 1, 1],
          [leaf('one-over-three/b'), leaf('one-over-three/c'), leaf('one-over-three/d')]
        ),
      ]
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
    id: 'three-plus-one',
    name: '3 + 1',
    root: split(
      'three-plus-one/root',
      'row',
      [1, 1.55],
      [
        split(
          'three-plus-one/left',
          'column',
          [1, 1, 1],
          [leaf('three-plus-one/a'), leaf('three-plus-one/b'), leaf('three-plus-one/c')]
        ),
        leaf('three-plus-one/d'),
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

export function defaultSplitScreenSceneLayout(): SplitScreenSceneLayout {
  return {
    name: 'Split screen',
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
  return mapSplitLayoutNode(root, (node) =>
    node.type === 'leaf' && node.id === leafId ? { ...node, sceneId } : node
  ) as SplitLayoutBranch
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
