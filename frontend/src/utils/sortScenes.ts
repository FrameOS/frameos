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
