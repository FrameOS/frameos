import type { StateField } from '../types'

/**
 * The render scale: what a scene is laid out and sized for. At 2 a .tsx/.jsx
 * app lays out for a panel half as wide and half as tall, and the result is
 * drawn sharp at the panel's full size, so a scene made for an 800x480 screen
 * fills a 1600x960 one instead of sitting small in whitespace. The frame's own
 * pages (the scene list, the settings) follow it too, and so do the text
 * app's sizes, a split's gaps and margins and a QR code's pixels.
 *
 * The scale in effect is the scene's own, else the frame's:
 *
 * - a field with `role: 'renderScale'` whose state holds a usable number (so
 *   a control panel can change it), else
 * - the scene's `settings.renderScale`, else
 * - the frame's (`render_scale` on both control planes, frame.json
 *   `renderScale`), where 0 is automatic: the largest of 1, 1.25, 1.5, 2,
 *   2.5, 3 and 4 that leaves a layout 640 px on the panel's shorter edge
 *   (1080 on HDMI, a screen seen from across a room), 1 where there is no
 *   panel.
 *
 * The runtime applies the same rules (`frameos/src/frameos/render_scale.nim`);
 * keep the two in step. docs/jsx-ui.md "Scale" is the spec.
 */

export const RENDER_SCALE_ROLE = 'renderScale'
export const RENDER_SCALE_LABEL = 'Scale'
export const MAX_RENDER_SCALE = 4
const HDMI_DEVICE = 'framebuffer'
/** A frame that draws for nobody: no panel to fit. */
const NO_PANEL = 'web_only'
/** The layout's shorter edge automatic leaves at least: on a panel, and on HDMI (seen from across a room). */
const PANEL_ROOM = 640
const HDMI_ROOM = 1080
/** What the automatic scale picks from: the steps from 1 up. */
const AUTO_STEPS: readonly number[] = [1, 1.25, 1.5, 2, 2.5, 3, 4]
/** The scales the settings offer; any other number up to 4 still works. */
/** Below 1 a layout gets more room than the panel has: everything drawn smaller. */
export const RENDER_SCALE_STEPS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]

export const RENDER_SCALE_HELP =
  'How large scenes are drawn: at 2× a scene is laid out for a screen half the size and drawn sharp at full size, ' +
  "so a scene made for a small screen fills a big one. The frame's own pages and text follow it too."
export const SCENE_RENDER_SCALE_HELP = "Overrides the frame's scale for this scene."

/**
 * The automatic scale: the largest step that leaves a layout 640 px on the
 * panel's shorter edge (1080 on HDMI); 1 without a panel (no device, or web_only).
 */
export function autoRenderScale(width: number, height: number, device?: string | null): number {
  if (!device || device === NO_PANEL) {
    return 1
  }
  const room = device === HDMI_DEVICE ? HDMI_ROOM : PANEL_ROOM
  const edge = Math.min(width, height)
  let scale = 1
  for (const step of AUTO_STEPS) {
    if (edge >= room * step) {
      scale = step
    }
  }
  return scale
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
export function automaticRenderScaleLabel(width: unknown, height: unknown, device?: string | null): string {
  const w = knownSize(width)
  const h = knownSize(height)
  return w !== null && h !== null
    ? `Automatic (${formatRenderScale(autoRenderScale(w, h, device))} on this panel)`
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
export function frameRenderScaleOptions(
  width: unknown,
  height: unknown,
  device?: string | null,
  current?: unknown
): RenderScaleOption[] {
  return [{ value: '0', label: automaticRenderScaleLabel(width, height, device) }, ...stepOptions(current)]
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
