import { sceneIdsRefer } from './systemScenes'

/**
 * The Activate button's own state, kept in controlLogic: armed when an
 * activation request leaves the browser, released when the frame logs that
 * scene's render:done (or a render error, a reconnect resync that already
 * shows the scene, or this timeout). Pure helpers here so the shared-spa
 * tests can pin them without mounting the logic's import graph.
 */

// How long an "Activating…" button keeps spinning without the frame
// reporting the render. A scene that fetches images can take a while; a
// frame that never answers should not spin forever.
export const SCENE_ACTIVATION_TIMEOUT_MS = 90_000

/** True while `sceneId` is the scene the frame was asked to activate and has not rendered yet. */
export function sceneIsActivating(activatingSceneId: string | null, sceneId: string): boolean {
  return activatingSceneId !== null && sceneIdsRefer(activatingSceneId, sceneId)
}
