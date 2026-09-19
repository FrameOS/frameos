import type { FrameOSScene, StateField } from './types'

/**
 * The scene's refresh interval as a state field: the field with
 * `role: 'refreshInterval'` (first wins), else a float or integer field
 * literally named `refreshInterval`, else an implicit public one seeded from
 * `settings.refreshInterval` and appended after the scene's own fields. A
 * declared field stays where the scene put it; a `refreshInterval` field of
 * another type is left alone and gets no implicit twin. The runtime applies
 * the same rules (frameos/src/frameos/refresh_interval.nim), so the implicit
 * field listed here is one the loaded scene really has.
 */

export const REFRESH_INTERVAL_ROLE = 'refreshInterval'
export const REFRESH_INTERVAL_FIELD_NAME = 'refreshInterval'
export const REFRESH_INTERVAL_LABEL = 'Refresh interval (seconds)'
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 300

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
  return list.findIndex(
    (field) => field?.name === REFRESH_INTERVAL_FIELD_NAME && (field.type === 'float' || field.type === 'integer')
  )
}

/** Every state field of the scene in its own order, plus the implicit refresh interval last when it has none. */
export function sceneStateFields(scene: Pick<FrameOSScene, 'fields' | 'settings'> | null | undefined): StateField[] {
  const fields = (scene?.fields ?? []).filter((field): field is StateField => !!field && typeof field === 'object')
  const index = refreshIntervalFieldIndex(fields)
  if (index >= 0) {
    return fields.map((field, i) => (i === index ? { ...field, role: REFRESH_INTERVAL_ROLE } : field))
  }
  if (fields.some((field) => field.name === REFRESH_INTERVAL_FIELD_NAME)) {
    // The name is taken by a field of another type: no implicit twin.
    return fields
  }
  const seconds = parseRefreshSeconds(scene?.settings?.refreshInterval) || DEFAULT_REFRESH_INTERVAL_SECONDS
  return [
    ...fields,
    {
      name: REFRESH_INTERVAL_FIELD_NAME,
      label: REFRESH_INTERVAL_LABEL,
      type: 'float',
      value: String(seconds),
      persist: 'disk',
      access: 'public',
      role: REFRESH_INTERVAL_ROLE,
    },
  ]
}
