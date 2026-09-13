import type { FrameScene } from '../types'

/**
 * Display order for every scene list: by name, "Scene 2" before "Scene 10",
 * ties broken by id so the order never wobbles between renders. Scenes
 * without a name fall back to their id rather than sorting as "".
 */
export function compareScenesByName(left: FrameScene, right: FrameScene): number {
  return (
    (left.name || left.id).localeCompare(right.name || right.id, undefined, {
      numeric: true,
      sensitivity: 'base',
    }) || String(left.id).localeCompare(String(right.id))
  )
}

export function sortScenesAlphabetically(scenes: FrameScene[]): FrameScene[] {
  return [...scenes].toSorted(compareScenesByName)
}

export type SceneSortOrder = 'recent' | 'name'

/**
 * "Recently used" order: scenes the frame has been seen running, newest first,
 * then everything never seen, alphabetically. No backend records scene usage,
 * so the stamps come from workspaceLogic's `sceneUsage` ledger — a frame whose
 * scenes have never been watched sorts exactly as it did before.
 */
export function sortScenesForDisplay(
  scenes: FrameScene[],
  order: SceneSortOrder,
  usedAt: (sceneId: string) => number | undefined
): FrameScene[] {
  if (order === 'name') {
    return sortScenesAlphabetically(scenes)
  }
  return [...scenes].toSorted((left, right) => {
    const leftUsed = usedAt(left.id)
    const rightUsed = usedAt(right.id)
    if (leftUsed !== rightUsed) {
      if (leftUsed === undefined) {
        return 1
      }
      if (rightUsed === undefined) {
        return -1
      }
      return rightUsed - leftUsed
    }
    return compareScenesByName(left, right)
  })
}
