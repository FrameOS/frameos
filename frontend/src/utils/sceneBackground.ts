import type { StateField } from '../types'

/**
 * A scene's background: the color under everything it draws, which shows as
 * bars around a photo shown whole on a screen of another shape. A field with
 * this role holds it, over `settings.backgroundColor`, so a control panel can
 * change it. Opt-in: no field is added for it, unlike the refresh interval.
 * The runtime's rule is frameos/src/frameos/scene_background.nim; keep the two
 * in step.
 */
export const BACKGROUND_COLOR_ROLE = 'backgroundColor'

/** The index of the scene's field with role backgroundColor, -1 for none. */
export function backgroundColorFieldIndex(fields: StateField[] | null | undefined): number {
  return (fields ?? []).findIndex((field) => field?.role === BACKGROUND_COLOR_ROLE)
}
