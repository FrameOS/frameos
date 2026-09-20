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

/**
 * Is the frame showing some OTHER scene than the one the editor has open?
 *
 * The device reports a scene it was handed ad hoc — every "Preview on frame",
 * and every interpreted scene it loaded from disk — as `uploaded/<id>`, so a
 * plain `!==` would call the editor's own scene a stranger the moment it is
 * previewed. An unknown live scene is not a mismatch: nothing is claimed
 * until the frame has said what it shows.
 */
export function otherSceneIsLive(liveSceneId: string | null | undefined, sceneId: string): boolean {
  return !!liveSceneId && !sceneIdsRefer(liveSceneId, sceneId)
}

/** What to call the live scene in the notice, or null when nothing names it. */
export function liveSceneLabel(
  liveSceneId: string | null | undefined,
  scenes: ReadonlyArray<{ id: string; name?: string }>
): string | null {
  if (!liveSceneId) {
    return null
  }
  if (liveSceneId === STATUS_SCREEN_SCENE_ID) {
    return STATUS_SCREEN_SCENE_NAME
  }
  if (isSystemSceneId(liveSceneId)) {
    return 'A system screen'
  }
  const id = publicSceneId(liveSceneId)
  return scenes.find((scene) => scene.id === id)?.name || null
}
