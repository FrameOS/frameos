import type { StateField } from '../types'

/**
 * A scene that asks the frame's layout for the whole panel (a reader, a photo):
 * a boolean field with this role holds the answer, over `settings.fullScreen`,
 * so the person at the frame turns it on and off in the scene's settings. The
 * layout hears it as `app.frame.fullScreen`. Opt-in: no field is added for it.
 * The runtime's rule is frameos/src/frameos/full_screen.nim; keep the two in
 * step (docs/scene-layouts.md "Full screen").
 */
export const FULL_SCREEN_ROLE = 'fullScreen'

/** The index of the scene's field with role fullScreen, -1 for none. */
export function fullScreenFieldIndex(fields: StateField[] | null | undefined): number {
  return (fields ?? []).findIndex((field) => field?.role === FULL_SCREEN_ROLE)
}
