/**
 * The runtime's built-in scenes (frameos/src/system/scenes.nim): ids under
 * `system/`, present on every frame, never in scenes.json. The one the
 * workspace shows is the status screen — the panel's name, address, scene
 * list and cloud link code, drawn when nothing else is installed.
 */
export const STATUS_SCREEN_SCENE_ID = 'system/index'
export const STATUS_SCREEN_SCENE_NAME = 'Status screen'

const SYSTEM_SCENE_PREFIX = 'system/'
// Runtimes before 2026.10.18 reported a scene they were handed (a cloud push,
// "Preview on frame", an admin upload) as `uploaded/<id>`; later ones use the
// scene's own id. This module is the only one that knows the old prefix:
// delete it, and the strip below, once those runtimes are gone.
const LEGACY_UPLOADED_SCENE_PREFIX = 'uploaded/'

export function isSystemSceneId(sceneId: string | null | undefined): boolean {
  return typeof sceneId === 'string' && sceneId.startsWith(SYSTEM_SCENE_PREFIX)
}

/** The id a scene is listed under, whichever runtime reported it (an older one says `uploaded/<id>`). */
export function publicSceneId(sceneId: string | null | undefined): string {
  if (!sceneId) {
    return ''
  }
  return sceneId.startsWith(LEGACY_UPLOADED_SCENE_PREFIX) ? sceneId.slice(LEGACY_UPLOADED_SCENE_PREFIX.length) : sceneId
}

/** Same scene, whether or not an older runtime put its legacy prefix on either id. */
export function sceneIdsRefer(first: string | null | undefined, second: string | null | undefined): boolean {
  const a = publicSceneId(first)
  const b = publicSceneId(second)
  return a.length > 0 && a === b
}

/** `record[sceneId]`, or the entry an older runtime keyed by the same scene's legacy id. */
export function sceneRecordEntry<T>(record: Record<string, T> | null | undefined, sceneId: string): T | undefined {
  if (!record) {
    return undefined
  }
  if (Object.prototype.hasOwnProperty.call(record, sceneId)) {
    return record[sceneId]
  }
  const key = Object.keys(record).find((candidate) => sceneIdsRefer(candidate, sceneId))
  return key === undefined ? undefined : record[key]
}

/**
 * Is the frame showing some OTHER scene than the one the editor has open?
 *
 * An older runtime reports a scene it was handed ad hoc (every "Preview on
 * frame") as `uploaded/<id>`, so a plain `!==` would call the editor's own
 * scene a stranger the moment it is previewed there. An unknown live scene is
 * not a mismatch: nothing is claimed until the frame has said what it shows.
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
