import { showAsFps } from '../decorators/refreshInterval'
import type { FrameScene, StateField } from '../types'

/**
 * The scene's refresh interval as a state field.
 *
 * Every scene has one state key that holds "seconds between renders":
 *
 * - a field marked `role: 'refreshInterval'` (the first one wins), else
 * - a float or integer field literally named `refreshInterval`, else
 * - an implicit public field `refreshInterval`, seeded from
 *   `settings.refreshInterval` and appended after the scene's own fields, so
 *   every surface that shows a scene's options ends with "Refresh interval
 *   (seconds)".
 *
 * A field the scene declares stays where the scene put it: declaring it is how
 * an author decides where the control goes, what it is called, and — with
 * `access: 'private'` — that people do not get one. A `refreshInterval` field
 * of any other type is the scene using the name for something else: it is left
 * alone and no implicit field is added over it (`key` is then empty).
 *
 * The runtime applies the same rules (`frameos/src/frameos/refresh_interval.nim`,
 * and `backend/app/utils/refresh_interval.py` for compiled scenes);
 * `frameos/wasm/src/refreshInterval.ts` is the preview package's copy. Keep
 * them in step.
 */

export const REFRESH_INTERVAL_ROLE = 'refreshInterval'
export const REFRESH_INTERVAL_FIELD_NAME = 'refreshInterval'
export const REFRESH_INTERVAL_LABEL = 'Refresh interval (seconds)'
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 300

type SceneLike = Pick<FrameScene, 'fields' | 'settings'> | null | undefined

/** A positive, finite number of seconds, or 0 for anything else. */
export function parseRefreshSeconds(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return 0
  }
  if (typeof value === 'string' && value.trim() === '') {
    return 0
  }
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

function isNumericField(field: StateField): boolean {
  return field.type === 'float' || field.type === 'integer'
}

/**
 * Index of the field that carries the refresh interval; -1 when the scene
 * declares none. A role beats the name, and the name only counts on a numeric field.
 */
export function refreshIntervalFieldIndex(fields: StateField[] | null | undefined): number {
  const list = fields ?? []
  const byRole = list.findIndex((field) => field?.role === REFRESH_INTERVAL_ROLE)
  if (byRole >= 0) {
    return byRole
  }
  return list.findIndex((field) => field?.name === REFRESH_INTERVAL_FIELD_NAME && isNumericField(field))
}

function settingsDefault(scene: SceneLike): number {
  return parseRefreshSeconds(scene?.settings?.refreshInterval) || DEFAULT_REFRESH_INTERVAL_SECONDS
}

export function implicitRefreshIntervalField(defaultSeconds: number): StateField {
  return {
    name: REFRESH_INTERVAL_FIELD_NAME,
    label: REFRESH_INTERVAL_LABEL,
    type: 'float',
    value: String(defaultSeconds),
    persist: 'disk',
    access: 'public',
    role: REFRESH_INTERVAL_ROLE,
  }
}

export interface ResolvedRefreshInterval {
  /** The scene's fields in their own order, plus the implicit one last. */
  fields: StateField[]
  /** The state key that holds the interval ('' = settings only). */
  key: string
  /** What the scene ships with. */
  defaultSeconds: number
  /** The field was added here, not declared by the scene. */
  implicit: boolean
}

export function resolveRefreshInterval(scene: SceneLike): ResolvedRefreshInterval {
  const fields = (scene?.fields ?? []).filter((field): field is StateField => !!field && typeof field === 'object')
  const index = refreshIntervalFieldIndex(fields)
  const declared = index >= 0 ? fields[index] : undefined
  if (declared) {
    return {
      // Stamp the role on a field taken over by name, so a surface only ever
      // has to ask `field.role === 'refreshInterval'`.
      fields: fields.map((field, i) => (i === index ? { ...field, role: REFRESH_INTERVAL_ROLE } : field)),
      key: declared.name,
      defaultSeconds: parseRefreshSeconds(declared.value) || settingsDefault(scene),
      implicit: false,
    }
  }
  const defaultSeconds = settingsDefault(scene)
  if (fields.some((field) => field.name === REFRESH_INTERVAL_FIELD_NAME)) {
    // The name is taken by a field of another type: settings only.
    return { fields, key: '', defaultSeconds, implicit: false }
  }
  return {
    fields: [...fields, implicitRefreshIntervalField(defaultSeconds)],
    key: REFRESH_INTERVAL_FIELD_NAME,
    defaultSeconds,
    implicit: true,
  }
}

/** Every state field of the scene in its own order, plus the implicit refresh interval last when it has none. */
export function sceneStateFields(scene: SceneLike): StateField[] {
  return resolveRefreshInterval(scene).fields
}

/** The fields a control surface offers: the public ones of sceneStateFields(). */
export function scenePublicStateFields(scene: SceneLike): StateField[] {
  return sceneStateFields(scene).filter((field) => field.access !== 'private')
}

/** "1 hour", "15 min", "24 fps": what a number of seconds means, for the hint next to the input. */
export function describeRefreshSeconds(value: unknown): string {
  const seconds = parseRefreshSeconds(value)
  return seconds > 0 ? showAsFps(seconds) : ''
}

/** The scene's seconds between renders, given the state it currently holds (if known). */
export function sceneRefreshSeconds(scene: SceneLike, state?: Record<string, unknown> | null): number {
  const { key, defaultSeconds } = resolveRefreshInterval(scene)
  return (key ? parseRefreshSeconds(state?.[key]) : 0) || defaultSeconds
}
