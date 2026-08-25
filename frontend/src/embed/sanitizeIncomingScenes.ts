import { FrameScene, FrameType } from '../types'
import { sanitizeScene } from '../scenes/frame/frameLogic'

/** Scenes reach the embedded editor straight from a host page: a scenes.json
 * download, a postMessage, an old version of a store scene. None of it has
 * been through the normalisation the full app runs on a frame it loads, and
 * reactflow dereferences node.position on every pass — so a scene saved
 * without node positions took the whole workspace down with "Cannot read
 * properties of undefined (reading 'x')" instead of just looking odd.
 *
 * sanitizeScene fills in what is missing, and arranges a scene whose nodes
 * have no positions at all. The editor echoes the result back through
 * onScenesChanged, which is the baseline hosts compare against for "unsaved",
 * so normalising on the way in costs nothing downstream. */
export function sanitizeIncomingScenes(scenes: unknown, frame: Partial<FrameType>): FrameScene[] {
  if (!Array.isArray(scenes)) {
    return []
  }
  return scenes
    .filter((scene): scene is Partial<FrameScene> => Boolean(scene) && typeof scene === 'object')
    .map((scene) => sanitizeScene(scene, frame))
}
