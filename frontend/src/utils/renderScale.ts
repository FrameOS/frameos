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
 *   `renderScale`), where 0 is automatic, a whole number: by the panel's
 *   density, its pixels per inch over 130 (the 7" to 7.5" 800x480 panels
 *   scenes are made on) to the nearest whole number, never below 1 and never
 *   leaving a layout under 576 px on the shorter edge; 1 for a panel of
 *   unknown size. HDMI is the largest whole number that leaves 1080 px, and
 *   no panel (web_only) is 1. Whole numbers keep lines and box edges on
 *   pixels; a fraction stays the owner's to set.
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
/** The density a scene's pixels are drawn at as made: the 7" to 7.5" 800x480 panels. */
const REFERENCE_PPI = 130
/** The shortest edge a layout is left: a smaller screen is seen closer, and a scene has to fit. */
const MIN_LAYOUT_EDGE = 576
/** HDMI: the layout's shorter edge automatic leaves at least. */
const HDMI_ROOM = 1080
/**
 * Panels whose name does not say their size, with a shorter edge of 720 px or
 * more (no other can scale). The runtime's `NamedPanelInches`
 * (frameos/src/frameos/render_scale.nim); docs/render-scale-fixtures.json pins both.
 */
const NAMED_PANEL_INCHES: Readonly<Record<string, number>> = {
  'pimoroni.inky_impression_13': 13.3,
  'pimoroni.hyperpixel4sq': 3.95,
  'pimoroni.hyperpixel4sq_touch': 3.95,
}
/** The scales the settings offer; any other number up to 4 still works. */
/** Below 1 a layout gets more room than the panel has: everything drawn smaller. */
export const RENDER_SCALE_STEPS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]

export const RENDER_SCALE_HELP =
  'How large scenes are drawn: at 2× a scene is laid out for a screen half the size and drawn sharp at full size, ' +
  "so a scene made for a small screen fills a big one. The frame's own pages and text follow it too."
export const SCENE_RENDER_SCALE_HELP = "Overrides the frame's scale for this scene."

/** The panel's diagonal in inches from its driver's name ("EPD_10in3" 10.3, "EPD_2in13_V4" 2.13); 0 when unknown. */
export function panelInches(device?: string | null): number {
  if (!device) {
    return 0
  }
  const named = NAMED_PANEL_INCHES[device]
  if (named !== undefined) {
    return named
  }
  const match = /(\d+)in(\d+)/.exec(device)
  return match ? Number(`${match[1]}.${match[2]}`) : 0
}

/**
 * The automatic scale, a whole number: by the panel's density when its size is
 * known (from its driver's name), by the room it leaves on HDMI, else 1.
 */
export function autoRenderScale(width: number, height: number, device?: string | null): number {
  const edge = Math.min(width, height)
  if (!device || device === NO_PANEL || !(edge > 0)) {
    return 1
  }
  if (device === HDMI_DEVICE) {
    return Math.min(MAX_RENDER_SCALE, Math.max(1, Math.floor(edge / HDMI_ROOM)))
  }
  const inches = panelInches(device)
  if (!(inches > 0)) {
    return 1
  }
  const ppi = Math.sqrt(width * width + height * height) / inches
  const dense = Math.floor(ppi / REFERENCE_PPI + 0.5)
  const fits = Math.floor(edge / MIN_LAYOUT_EDGE)
  return Math.min(MAX_RENDER_SCALE, Math.max(1, Math.min(dense, fits)))
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
