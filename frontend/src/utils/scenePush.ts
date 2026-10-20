import type { FrameScene } from '../types'

// What "Push" from the scene drawer sends (docs/ui-vocabulary.md): the scene
// and the connected scenes it needs that have changes of their own. A
// connected scene is one this scene draws (a scene node, a split's panel) or
// switches to (a setCurrentScene dispatch), transitively: the same set an
// on-frame preview sends. An unchanged connected scene is on the frame
// already, and every push carries the frame's whole saved list, so "always
// with connected" and "connected if changed" send the same thing. Unrelated
// scenes keep their unsaved edits, and the frame settings are not touched.

export function referencedSceneIds(scene: FrameScene): string[] {
  const sceneIds = new Set<string>()

  for (const node of scene.nodes ?? []) {
    const data = node.data as any
    if (node.type === 'scene' && typeof data?.keyword === 'string' && data.keyword) {
      sceneIds.add(data.keyword)
    } else if (node.type === 'dispatch' && data?.keyword === 'setCurrentScene') {
      const targetSceneId = data?.config?.sceneId
      if (typeof targetSceneId === 'string' && targetSceneId) {
        sceneIds.add(targetSceneId)
      }
    }
  }

  return Array.from(sceneIds)
}

/** The scene and its connected scenes, in visiting order, root first. */
export function connectedSceneIds(rootSceneId: string, scenes: readonly FrameScene[]): string[] {
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]))
  const visited: string[] = []
  const seen = new Set<string>()
  const visit = (sceneId: string): void => {
    const scene = sceneById.get(sceneId)
    if (!scene || seen.has(sceneId)) {
      return
    }
    seen.add(sceneId)
    visited.push(sceneId)
    for (const referencedSceneId of referencedSceneIds(scene)) {
      visit(referencedSceneId)
    }
  }
  visit(rootSceneId)
  return visited
}

/** Which of the scene's connected scenes (itself included) a push sends: the ones with changes. */
export function scenePushSceneIds(
  rootSceneId: string,
  scenes: readonly FrameScene[],
  changedSceneIds: ReadonlySet<string>
): string[] {
  return connectedSceneIds(rootSceneId, scenes).filter((sceneId) => changedSceneIds.has(sceneId))
}

/**
 * The saved scene list with the pushed scenes' edited versions in it: the
 * list a push saves (backend) or sends (cloud). Scenes new to the list keep
 * the order they have in the form, after the saved ones.
 */
export function savedScenesWithPushed(
  savedScenes: readonly FrameScene[],
  formScenes: readonly FrameScene[],
  pushedSceneIds: readonly string[]
): FrameScene[] {
  const pushed = new Set(pushedSceneIds)
  const formById = new Map(formScenes.filter((scene) => pushed.has(scene.id)).map((scene) => [scene.id, scene]))
  const merged = savedScenes.map((scene) => formById.get(scene.id) ?? scene)
  const savedIds = new Set(savedScenes.map((scene) => scene.id))
  for (const scene of formScenes) {
    if (pushed.has(scene.id) && !savedIds.has(scene.id)) {
      merged.push(scene)
    }
  }
  return merged
}

/**
 * The scene drawer's main action while the scene has changes: what it is
 * called and what it does. `saves`: the push saves edits first (the backend;
 * the cloud has no scene save). `connected`: the connected scenes that go
 * with it.
 */
export function scenePushActionCopy({
  active,
  connected,
  saves,
}: {
  active: boolean
  connected: number
  saves: boolean
}): { label: string; description: string } {
  const what = connected ? `this scene and ${connected} connected scene${connected === 1 ? '' : 's'}` : 'this scene'
  return {
    label: active ? 'Push to frame' : 'Push & activate',
    description: `${saves ? 'Save and push' : 'Push'} ${what} to the frame${active ? '' : ', then show it'}`,
  }
}
