import type { FrameScene, SceneNodeData } from '../../types'
import { sceneChildExpansionKey } from './workspaceLogic'

export interface SceneDependencyEntry {
  scene: FrameScene
  key: string
  nested: boolean
}

export interface SceneDependencyGraph {
  childrenBySceneId: Map<string, string[]>
  sceneById: Map<string, FrameScene>
}

export function sortScenesAlphabetically(scenes: FrameScene[]): FrameScene[] {
  return [...scenes].toSorted((left, right) => (left.name || left.id).localeCompare(right.name || right.id))
}

function sceneChildIds(scene: FrameScene, sceneById: Map<string, FrameScene>): string[] {
  const childIds = new Set<string>()

  for (const node of scene.nodes ?? []) {
    if (node.type !== 'scene') {
      continue
    }
    const childId = (node.data as SceneNodeData | undefined)?.keyword
    if (childId && childId !== scene.id && sceneById.has(childId)) {
      childIds.add(childId)
    }
  }

  return Array.from(childIds)
}

export function buildSceneDependencyGraph(scenes: FrameScene[]): SceneDependencyGraph {
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]))
  return {
    childrenBySceneId: new Map(scenes.map((scene) => [scene.id, sceneChildIds(scene, sceneById)])),
    sceneById,
  }
}

function sceneHasMatchingDescendant(
  sceneId: string,
  childrenBySceneId: Map<string, string[]>,
  matchingSceneIds: Set<string>,
  visited = new Set<string>()
): boolean {
  if (visited.has(sceneId)) {
    return false
  }
  visited.add(sceneId)

  for (const childId of childrenBySceneId.get(sceneId) ?? []) {
    if (
      matchingSceneIds.has(childId) ||
      sceneHasMatchingDescendant(childId, childrenBySceneId, matchingSceneIds, visited)
    ) {
      return true
    }
  }
  return false
}

export function buildSceneDependencyEntries({
  childrenBySceneId,
  frameId,
  matchingSceneIds,
  sceneById,
  sceneChildExpansion,
  scenes,
}: {
  childrenBySceneId: Map<string, string[]>
  frameId: number
  matchingSceneIds: Set<string> | null
  sceneById: Map<string, FrameScene>
  sceneChildExpansion: Record<string, boolean>
  scenes: FrameScene[]
}): SceneDependencyEntry[] {
  const referencedSceneIds = new Set<string>()
  for (const childIds of childrenBySceneId.values()) {
    childIds.forEach((childId) => referencedSceneIds.add(childId))
  }

  const rootCandidates = scenes.filter((scene) => !referencedSceneIds.has(scene.id))
  const rootScenes = rootCandidates.length > 0 ? rootCandidates : scenes
  const visibleRootScenes = matchingSceneIds
    ? rootScenes.filter(
        (scene) =>
          matchingSceneIds.has(scene.id) || sceneHasMatchingDescendant(scene.id, childrenBySceneId, matchingSceneIds)
      )
    : rootScenes
  const entries: SceneDependencyEntry[] = []

  const appendScene = (scene: FrameScene, nested: boolean, path: string, visited: Set<string>): void => {
    entries.push({ scene, key: path, nested })
    if (!sceneChildExpansion[sceneChildExpansionKey(frameId, scene.id)]) {
      return
    }

    const nextVisited = new Set(visited)
    nextVisited.add(scene.id)
    for (const childId of childrenBySceneId.get(scene.id) ?? []) {
      if (nextVisited.has(childId)) {
        continue
      }
      const childScene = sceneById.get(childId)
      if (childScene) {
        appendScene(childScene, true, `${path}/${childScene.id}`, nextVisited)
      }
    }
  }

  visibleRootScenes.forEach((scene) => appendScene(scene, false, scene.id, new Set<string>()))
  return entries
}

export function flatSceneDependencyEntries(scenes: FrameScene[]): SceneDependencyEntry[] {
  return scenes.map((scene) => ({ scene, key: scene.id, nested: false }))
}
