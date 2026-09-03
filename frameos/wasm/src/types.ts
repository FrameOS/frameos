// Types for the FrameOS scenes JSON and the preview worker protocol. These
// mirror the FrameOS backend/frontend definitions (frontend/src/types.tsx and
// frameos/src/frameos/types.nim) for the parts a browser preview needs.

/** One showIf condition: compare a (state) field's value against `value`. */
export interface ConfigFieldCondition {
  field?: string
  operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'empty' | 'notEmpty' | 'in' | 'notIn' | null
  value?: unknown
}

/** All conditions inside `and` must match; top-level conditions are OR-ed. */
export interface ConfigFieldConditionAnd {
  and: ConfigFieldCondition[]
}

export type ShowIfCondition = ConfigFieldCondition | ConfigFieldConditionAnd

/**
 * One choice of a 'select' field: a plain string (the value doubles as the label),
 * or an explicit pair when the stored value and the text shown differ.
 */
export type SelectFieldOption = string | { value: string; label: string }

/** A scene state field, as found in a scene JSON's `fields` array. */
export interface StateField {
  name: string
  label?: string
  type?: string
  value?: unknown
  options?: SelectFieldOption[]
  placeholder?: string
  required?: boolean
  secret?: boolean
  persist?: 'memory' | 'disk'
  access?: 'private' | 'public'
  showIf?: ShowIfCondition[]
}

export interface SceneNode {
  id?: string
  type?: string
  data?: Record<string, unknown> & { keyword?: string; config?: Record<string, unknown> }
}

/** A FrameOS scene as exported in scenes.json / template zips. */
export interface FrameOSScene {
  id: string
  name?: string
  nodes?: SceneNode[]
  edges?: unknown[]
  fields?: StateField[]
  settings?: Record<string, unknown>
  default?: boolean
  [key: string]: unknown
}

/** frameos_wasm_scene_info() payload, sent with the worker's `ready` message. */
export interface SceneInfo {
  loaded: number
  currentSceneId: string
  currentSceneName: string
  defaultSceneId: string
  renderRequested: boolean
  scenes: { id: string; name: string; refreshInterval: number }[]
}

export interface PreviewFrame {
  width: number
  height: number
  renderMs: number
}

/** One entry of the browser asset folder (the runtime's /srv/assets). */
export interface PreviewAssetEntry {
  /** Path relative to the folder root, e.g. `photos/beach.jpg`. */
  path: string
  /** Bytes; 0 for folders. */
  size: number
  /** Last modification, ms since the epoch. */
  mtime: number
  isDir: boolean
}

/** What the worker reports about the runtime itself (its `ready` message). */
export interface PreviewRuntimeInfo {
  /** The FrameOS version the wasm bundle was built from, in the published
   * form a frame reports ("2026.9.0") — null for a bundle older than the
   * export. The preview renders with this interpreter; a frame renders with
   * its own firmware, and the two can differ between releases. */
  version: string | null
}

/** How the runtime's /srv/assets is backed, sent with the worker's `ready` message. */
export interface PreviewAssetsInfo {
  /** False when the wasm bundle has no filesystem export at all. */
  mounted: boolean
  /** True when the folder is kept in this browser's IndexedDB between
   * previews; false when it lives in memory for this worker only. */
  persistent: boolean
  /** The folder's absolute path inside the runtime (`/srv/assets`). */
  root: string
  /** Size ceiling for the folder in bytes. */
  maxBytes: number
}

/** An interactive scene event (custom `event` node) usable as a button. */
export interface SceneEventButton {
  keyword: string
  label: string | null
}

/** Events every scene handles on its own; not useful as interactive buttons. */
export const LIFECYCLE_EVENTS = new Set(['render', 'init', 'open', 'close', 'setSceneState', 'setCurrentScene'])

/** The custom event nodes of a scene, deduplicated — render these as buttons. */
export function sceneEventButtons(scene: FrameOSScene | undefined | null): SceneEventButton[] {
  if (!scene) {
    return []
  }
  const events: SceneEventButton[] = []
  const seen = new Set<string>()
  for (const node of scene.nodes ?? []) {
    if (node.type !== 'event') {
      continue
    }
    const data = (node.data ?? {}) as Record<string, unknown> & { config?: Record<string, unknown> }
    const keyword = String(data.keyword ?? '')
    if (!keyword || LIFECYCLE_EVENTS.has(keyword)) {
      continue
    }
    const label = (data.config?.label ?? data.label ?? null) as string | null
    const dedupeKey = `${keyword}:${label ?? ''}`
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey)
      events.push({ keyword, label: label ? String(label) : null })
    }
  }
  return events
}
