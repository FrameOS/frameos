/**
 * The runtime's built-in scenes (frameos/src/system/scenes.nim): ids under
 * `system/`, present on every frame, never in scenes.json. The one the
 * workspace shows is the status screen — the panel's name, address, scene
 * list and cloud link code, drawn when nothing else is installed.
 */
export const STATUS_SCREEN_SCENE_ID = 'system/index'
export const STATUS_SCREEN_SCENE_NAME = 'Status screen'

const SYSTEM_SCENE_PREFIX = 'system/'
const UPLOADED_SCENE_PREFIX = 'uploaded/'

export function isSystemSceneId(sceneId: string | null | undefined): boolean {
  return typeof sceneId === 'string' && sceneId.startsWith(SYSTEM_SCENE_PREFIX)
}

/** The id a scene is listed under: an interpreted scene the device loaded from disk reports itself as `uploaded/<id>`. */
export function publicSceneId(sceneId: string | null | undefined): string {
  if (!sceneId) {
    return ''
  }
  return sceneId.startsWith(UPLOADED_SCENE_PREFIX) ? sceneId.slice(UPLOADED_SCENE_PREFIX.length) : sceneId
}

/** Same scene, whichever side carries the `uploaded/` prefix. */
export function sceneIdsRefer(first: string | null | undefined, second: string | null | undefined): boolean {
  const a = publicSceneId(first)
  const b = publicSceneId(second)
  return a.length > 0 && a === b
}
