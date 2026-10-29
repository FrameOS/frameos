import type { StateField } from '../types'

/**
 * The render scale: what a UI from a .tsx/.jsx app is laid out for. At 2 the
 * app lays out for a panel half as wide and half as tall, and the result is
 * drawn sharp at the panel's full size, so a scene made for an 800x480 screen
 * fills a 1600x960 one instead of sitting small in whitespace.
 *
 * The scale in effect is the scene's own, else the frame's:
 *
 * - a field with `role: 'renderScale'` whose state holds a usable number (so
 *   a control panel can change it), else
 * - the scene's `settings.renderScale`, else
 * - the frame's (`render_scale` on both control planes, frame.json
 *   `renderScale`), where 0 is automatic: the panel's shorter edge over
 *   600 px, rounded down to a quarter, never below 1.
 *
 * The runtime applies the same rules (`frameos/src/frameos/render_scale.nim`);
 * keep the two in step. docs/jsx-ui.md "Scale" is the spec.
 */

export const RENDER_SCALE_ROLE = 'renderScale'
export const RENDER_SCALE_LABEL = 'Scale'
export const MAX_RENDER_SCALE = 4
/** The shorter edge that automatic scaling treats as 1×. */
export const AUTO_RENDER_SCALE_EDGE = 600
/** The scales the settings offer; any other number up to 4 still works. */
export const RENDER_SCALE_STEPS: readonly number[] = [1, 1.25, 1.5, 2, 2.5, 3, 4]

export const RENDER_SCALE_HELP =
  'Scenes built with JSX are laid out for a screen this many times smaller and drawn sharp at full size, so a ' +
  'scene made for a small screen fills a big one.'
export const SCENE_RENDER_SCALE_HELP = "Overrides the frame's scale for this scene."

/** The automatic scale for a panel: its shorter edge over 600 px, rounded down to a quarter, at least 1. */
export function autoRenderScale(width: number, height: number): number {
  const edge = Math.min(width, height)
  if (!Number.isFinite(edge) || edge <= 0) {
    return 1
  }
  return Math.max(1, Math.floor((edge / AUTO_RENDER_SCALE_EDGE) * 4) / 4)
}

/** A scale in (0, 4], or 0 for anything else (0 itself means "not set"). Lenient: forms hold numbers as strings. */
export function parseRenderScale(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return 0
  }
  if (typeof value === 'string' && value.trim() === '') {
    return 0
  }
  const scale = Number(value)
  return Number.isFinite(scale) && scale > 0 && scale <= MAX_RENDER_SCALE ? scale : 0
}

/** "1.25×". */
export function formatRenderScale(scale: number): string {
  return `${Number(scale.toFixed(3))}×`
}

function knownSize(value: unknown): number | null {
  const size = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(size) && size > 0 ? size : null
}

/** "Automatic (2× on this panel)", or just "Automatic" when the panel's size is unknown. */
export function automaticRenderScaleLabel(width: unknown, height: unknown): string {
  const w = knownSize(width)
  const h = knownSize(height)
  return w !== null && h !== null
    ? `Automatic (${formatRenderScale(autoRenderScale(w, h))} on this panel)`
    : 'Automatic'
}

export interface RenderScaleOption {
  value: string
  label: string
}

function stepOptions(current: unknown): RenderScaleOption[] {
  const steps = [...RENDER_SCALE_STEPS]
  // A scale set elsewhere (the API, an MCP tool) stays selectable as itself.
  const own = parseRenderScale(current)
  if (own > 0 && !steps.includes(own)) {
    steps.push(own)
    steps.sort((a, b) => a - b)
  }
  return steps.map((scale) => ({
    value: String(scale),
    label: scale === 1 ? '1× (as designed)' : formatRenderScale(scale),
  }))
}

/** The frame's Scale select: Automatic (value "0") and the steps. */
export function frameRenderScaleOptions(width: unknown, height: unknown, current?: unknown): RenderScaleOption[] {
  return [{ value: '0', label: automaticRenderScaleLabel(width, height) }, ...stepOptions(current)]
}

/** A scene's Scale select: the frame's (value "") and the steps. */
export function sceneRenderScaleOptions(current?: unknown): RenderScaleOption[] {
  return [{ value: '', label: "The frame's" }, ...stepOptions(current)]
}

/** The frame's stored scale as the select's value: "0" for automatic. */
export function frameRenderScaleSelectValue(value: unknown): string {
  return String(parseRenderScale(value))
}

/** A scene's `settings.renderScale` as the select's value: "" for the frame's. */
export function sceneRenderScaleSelectValue(value: unknown): string {
  const scale = parseRenderScale(value)
  return scale > 0 ? String(scale) : ''
}

/** The select's value as a scene setting: undefined (the key is dropped) for the frame's. */
export function sceneRenderScaleFromSelect(value: string): number | undefined {
  const scale = parseRenderScale(value)
  return scale > 0 ? scale : undefined
}

/** Index of the scene's first field with the renderScale role; -1 when it declares none. */
export function renderScaleFieldIndex(fields: StateField[] | null | undefined): number {
  return (fields ?? []).findIndex((field) => field?.role === RENDER_SCALE_ROLE)
}
