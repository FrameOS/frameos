import { FrameScene, SceneNodeData } from '../../../../types'

export function findConnectedScenes(scenes: FrameScene[], sceneId: string): string[] {
  const scenesById = Object.fromEntries(scenes.map((s) => [s.id, s]))
  const connectedScenes: Set<string> = new Set()
  const queue = [sceneId]
  while (queue.length > 0) {
    const currentSceneId = queue.shift()!
    const currentScene = scenesById[currentSceneId]
    if (!currentScene) {
      continue
    }
    connectedScenes.add(currentSceneId)
    currentScene.nodes
      .filter((node) => node.type === 'scene')
      .map((node) => (node.data as SceneNodeData)?.keyword)
      .filter(Boolean)
      .forEach((linkedSceneId) => {
        if (!connectedScenes.has(linkedSceneId)) {
          queue.push(linkedSceneId)
        }
      })
  }
  return Array.from(connectedScenes)
}
