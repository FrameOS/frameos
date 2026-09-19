import type { FrameOSScene, StateField } from './types'

/**
 * The scene's refresh interval as a state field: the field with
 * `role: 'refreshInterval'` (first wins), else a field literally named
 * `refreshInterval`, else an implicit public one seeded from
 * `settings.refreshInterval`. It is always listed last. The runtime applies
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

/** Index of the field that carries the refresh interval; -1 when the scene declares none. */
export function refreshIntervalFieldIndex(fields: StateField[] | null | undefined): number {
  const list = fields ?? []
  const byRole = list.findIndex((field) => field?.role === REFRESH_INTERVAL_ROLE)
  return byRole >= 0 ? byRole : list.findIndex((field) => field?.name === REFRESH_INTERVAL_FIELD_NAME)
}

/** Every state field of the scene, with the refresh interval (declared or implicit) last. */
export function sceneStateFields(scene: Pick<FrameOSScene, 'fields' | 'settings'> | null | undefined): StateField[] {
  const fields = (scene?.fields ?? []).filter((field): field is StateField => !!field && typeof field === 'object')
  const index = refreshIntervalFieldIndex(fields)
  const declared = index >= 0 ? fields[index] : undefined
  if (!declared) {
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
  return [...fields.filter((_, i) => i !== index), { ...declared, role: REFRESH_INTERVAL_ROLE }]
}
