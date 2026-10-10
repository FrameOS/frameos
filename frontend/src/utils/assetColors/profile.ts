/**
 * Per-image color profiles: the `<image>.frameos.json` sidecar.
 *
 * The TypeScript half of `frameos/src/frameos/utils/asset_colors.nim`. The
 * runtime reads this file next to a photo and applies it before the panel
 * dither; the Assets panel's editor writes it and previews it with the same
 * arithmetic (`adjust.ts`, `dither.ts`). `docs/asset-color-profiles.md` is
 * the contract. Keep the two sides in step.
 *
 * The name is deliberately not dot-prefixed: every device write path refuses
 * hidden names, and the sidecar must travel through the same verbs an image
 * does (upload, rename, delete, on every control plane).
 */

export const ASSET_COLOR_SIDECAR_SUFFIX = '.frameos.json'

export const HUE_RANGE_NAMES = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const
export type HueRangeName = (typeof HUE_RANGE_NAMES)[number]

export const TONE_RANGE_NAMES = ['shadows', 'midtones', 'highlights'] as const
export type ToneRangeName = (typeof TONE_RANGE_NAMES)[number]

/** -100 .. 100 each. */
export interface ToneRange {
  luminance: number
  r: number
  g: number
  b: number
}

/** `hue` is a rotation in degrees (-180 .. 180); the other two are -100 .. 100. */
export interface HueRange {
  hue: number
  saturation: number
  luminance: number
}

export type RgbTriplet = [number, number, number]

export interface AssetColorProfile {
  /** Stops, -3 .. 3. */
  exposure: number
  contrast: number
  /** Negative pulls the highlights below the panel's white. */
  whites: number
  /** Positive lifts the shadows. */
  blacks: number
  saturation: number
  shadows: ToneRange
  midtones: ToneRange
  highlights: ToneRange
  hues: Record<HueRangeName, HueRange>
  /** The dither palette for this photo, or null for the panel's own. */
  palette: RgbTriplet[] | null
}

export function emptyToneRange(): ToneRange {
  return { luminance: 0, r: 0, g: 0, b: 0 }
}

export function emptyHueRange(): HueRange {
  return { hue: 0, saturation: 0, luminance: 0 }
}

export function defaultAssetColorProfile(): AssetColorProfile {
  return {
    exposure: 0,
    contrast: 0,
    whites: 0,
    blacks: 0,
    saturation: 0,
    shadows: emptyToneRange(),
    midtones: emptyToneRange(),
    highlights: emptyToneRange(),
    hues: Object.fromEntries(HUE_RANGE_NAMES.map((name) => [name, emptyHueRange()])) as Record<HueRangeName, HueRange>,
    palette: null,
  }
}

export function sidecarPathFor(imagePath: string): string {
  return `${imagePath}${ASSET_COLOR_SIDECAR_SUFFIX}`
}

export function isSidecarPath(path: string): boolean {
  return path.endsWith(ASSET_COLOR_SIDECAR_SUFFIX)
}

/** The image a sidecar belongs to, or null for any other file. */
export function sidecarImagePath(path: string): string | null {
  return isSidecarPath(path) ? path.slice(0, -ASSET_COLOR_SIDECAR_SUFFIX.length) : null
}

function toneHasAdjustments(tone: ToneRange): boolean {
  return tone.luminance !== 0 || tone.r !== 0 || tone.g !== 0 || tone.b !== 0
}

/** Whether applying the profile could change a pixel (the palette aside). */
export function profileHasAdjustments(profile: AssetColorProfile): boolean {
  if (
    profile.exposure !== 0 ||
    profile.contrast !== 0 ||
    profile.whites !== 0 ||
    profile.blacks !== 0 ||
    profile.saturation !== 0
  ) {
    return true
  }
  if ([profile.shadows, profile.midtones, profile.highlights].some(toneHasAdjustments)) {
    return true
  }
  return HUE_RANGE_NAMES.some((name) => {
    const hue = profile.hues[name]
    return hue.hue !== 0 || hue.saturation !== 0 || hue.luminance !== 0
  })
}

export function profileIsDefault(profile: AssetColorProfile): boolean {
  return !profileHasAdjustments(profile) && !profile.palette
}

function clampSlider(value: unknown, lo = -100, hi = 100): number {
  const parsed = typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : 0
  if (!Number.isFinite(parsed)) {
    return 0
  }
  return Math.max(lo, Math.min(hi, parsed))
}

function toneOf(value: unknown): ToneRange {
  const node = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    luminance: clampSlider(node.luminance),
    r: clampSlider(node.r),
    g: clampSlider(node.g),
    b: clampSlider(node.b),
  }
}

function hueOf(value: unknown): HueRange {
  const node = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    hue: clampSlider(node.hue, -180, 180),
    saturation: clampSlider(node.saturation),
    luminance: clampSlider(node.luminance),
  }
}

export function hexToTriplet(hex: string): RgbTriplet | null {
  const text = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(text)) {
    return null
  }
  return [parseInt(text.slice(0, 2), 16), parseInt(text.slice(2, 4), 16), parseInt(text.slice(4, 6), 16)]
}

export function tripletToHex([r, g, b]: RgbTriplet): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

/** `["#rrggbb", …]` or `[[r, g, b], …]`; one bad entry voids the override. */
export function parsePalette(value: unknown): RgbTriplet[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }
  const palette: RgbTriplet[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const triplet = hexToTriplet(entry)
      if (!triplet) {
        return null
      }
      palette.push(triplet)
    } else if (Array.isArray(entry) && entry.length === 3 && entry.every((channel) => typeof channel === 'number')) {
      palette.push(entry.map((channel: number) => Math.max(0, Math.min(255, Math.round(channel)))) as RgbTriplet)
    } else {
      return null
    }
  }
  return palette
}

/** `{"version": 1, "colors": {...}}` → profile, or null when it is not one. */
export function parseAssetColorProfile(root: unknown): AssetColorProfile | null {
  if (!root || typeof root !== 'object') {
    return null
  }
  const colors = (root as Record<string, unknown>).colors
  if (!colors || typeof colors !== 'object') {
    return null
  }
  const node = colors as Record<string, unknown>
  const hues = node.hues && typeof node.hues === 'object' ? (node.hues as Record<string, unknown>) : {}
  return {
    exposure: clampSlider(node.exposure, -3, 3),
    contrast: clampSlider(node.contrast),
    whites: clampSlider(node.whites),
    blacks: clampSlider(node.blacks),
    saturation: clampSlider(node.saturation),
    shadows: toneOf(node.shadows),
    midtones: toneOf(node.midtones),
    highlights: toneOf(node.highlights),
    hues: Object.fromEntries(HUE_RANGE_NAMES.map((name) => [name, hueOf(hues[name])])) as Record<
      HueRangeName,
      HueRange
    >,
    palette: parsePalette(node.palette),
  }
}

/** The sidecar's JSON, with neutral sliders left out so the file stays readable. */
export function serializeAssetColorProfile(profile: AssetColorProfile): string {
  const colors: Record<string, unknown> = {}
  for (const key of ['exposure', 'contrast', 'whites', 'blacks', 'saturation'] as const) {
    if (profile[key] !== 0) {
      colors[key] = profile[key]
    }
  }
  for (const key of TONE_RANGE_NAMES) {
    if (toneHasAdjustments(profile[key])) {
      colors[key] = profile[key]
    }
  }
  const hues: Record<string, HueRange> = {}
  for (const name of HUE_RANGE_NAMES) {
    const hue = profile.hues[name]
    if (hue.hue !== 0 || hue.saturation !== 0 || hue.luminance !== 0) {
      hues[name] = hue
    }
  }
  if (Object.keys(hues).length > 0) {
    colors.hues = hues
  }
  if (profile.palette && profile.palette.length > 0) {
    colors.palette = profile.palette.map(tripletToHex)
  }
  return JSON.stringify({ version: 1, colors }, null, 2) + '\n'
}
