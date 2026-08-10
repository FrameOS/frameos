import type { FrameScene } from '../types'

// The cloud control plane stores a frame's scene list as store-scene
// assignments (frame_scene_assignments rows), not as scene JSON on the frame
// row — GET /api/frames and /api/frames/{id} serve frameSummary, which has no
// scenes at all, so a reload used to blank every scene tile. The workspace
// hydrates them client-side instead: list the assignments
// (GET /api/frames/{frameId}/scenes), fetch each store scene's scenes.json
// (the same payload the device receives over set_scenes, carrying the RUNTIME
// scene ids the device reports back as active_scene), and merge the result
// into the stored frame (framesModel.hydrateCloudFrameScenes).
//
// Deliberately import-free beyond the type barrel (type-only, erased at
// compile time): the cloud app's node test suite exercises these helpers
// directly.

/** One row of GET /api/frames/{frameId}/scenes (cloud/apps/auth-web/app/api/frames/[frameId]/scenes/route.ts). */
export interface CloudFrameSceneRow {
  /** STORE scene uuid — not the runtime scene id inside scenes.json. */
  scene_id: string
  /** null/undefined = the assignment tracks the latest published version. */
  scene_version?: number | null
  name?: string | null
  slug?: string | null
  position?: number | null
  visibility?: string | null
}

/** Cache key for a store scene's scenes.json fetch. */
export function cloudSceneCacheKey(row: CloudFrameSceneRow): string {
  return `${row.scene_id}@${row.scene_version ?? 'latest'}`
}

/**
 * scenes.json is a JSON array of full scene objects — the store validates
 * that shape at publish time (extractScenesJson in the scenes.json route).
 * Anything else returns null so the caller falls back to a stub tile instead
 * of feeding garbage to the scene renderers.
 */
export function scenesFromStoreSceneJson(json: unknown): FrameScene[] | null {
  if (!Array.isArray(json) || json.length === 0) {
    return null
  }
  const allScenesShaped = json.every(
    (scene) => !!scene && typeof scene === 'object' && typeof (scene as { id?: unknown }).id === 'string'
  )
  return allScenesShaped ? (json as FrameScene[]) : null
}

/**
 * Placeholder tile when a scene's scenes.json cannot be fetched (network
 * blip, scene pulled from the store, private scene the session cannot read).
 * The store uuid stands in for the runtime id — the tile still names the
 * scene, it just cannot light the Active badge or count nodes.
 */
export function cloudSceneStub(row: CloudFrameSceneRow): FrameScene {
  return {
    id: row.scene_id,
    name: row.name || row.slug || 'Untitled scene',
    nodes: [],
    edges: [],
  }
}

/**
 * The hub mirrors the device's reported state onto the frame row as
 * `last_state`; `last_state.active_scene` carries the RUNTIME scene id. Cloud
 * frames have no backend websocket log stream to infer the active scene from
 * (framesModel's newLog reducer never fires), so this is the only signal that
 * survives a reload.
 */
export function activeSceneFromLastState(lastState: unknown): string | null {
  if (!lastState || typeof lastState !== 'object') {
    return null
  }
  const activeScene = (lastState as { active_scene?: unknown }).active_scene
  return typeof activeScene === 'string' && activeScene ? activeScene : null
}
