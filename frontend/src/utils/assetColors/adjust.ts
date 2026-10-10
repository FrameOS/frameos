/**
 * The color pipeline, mirrored line for line from
 * `frameos/src/frameos/utils/asset_colors.nim` (`adjustPixel`, `autoFitFor`).
 * The order is the order a photographer reasons in: exposure, the end
 * points, contrast, the tonal tints, saturation, then the per-hue
 * corrections. Channels are floats 0 .. 1 between steps and 8-bit at the
 * ends, like the runtime.
 */
import { HUE_RANGE_NAMES, type AssetColorProfile, type RgbTriplet, profileHasAdjustments } from './profile'

// The grey weights the dither uses (frameos/utils/dither: toGrayscaleFloat).
const LUM_R = 0.21
const LUM_G = 0.72
const LUM_B = 0.07

const HUE_RANGE_CENTRES = [0, 30, 60, 120, 180, 240, 280, 320]

export function luminance(r: number, g: number, b: number): number {
  return LUM_R * r + LUM_G * g + LUM_B * b
}

/** The darkest and brightest luminance a palette can show, 0 .. 1. */
export function paletteRange(palette: RgbTriplet[] | null): { lo: number; hi: number } {
  if (!palette || palette.length === 0) {
    return { lo: 0, hi: 1 }
  }
  let lo = 1
  let hi = 0
  for (const [r, g, b] of palette) {
    if (r >= 999) {
      continue
    }
    const lum = luminance(r, g, b) / 255
    lo = Math.min(lo, lum)
    hi = Math.max(hi, lum)
  }
  return hi <= lo ? { lo: 0, hi: 1 } : { lo, hi }
}

/**
 * How far the end points travel at ±100: a white point of 1.4 is what a
 * Spectra panel's white (luminance 0.74) needs to take a photo's full range,
 * which is what the Auto preset asks for. `EndPointRange` in asset_colors.nim.
 */
export const END_POINT_RANGE = 0.4

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * Piecewise-linear interpolation between neighbouring hue centres: a hue
 * between red (0°) and orange (30°) is partly both, and the weights sum to one.
 */
function hueWeights(hue: number): number[] {
  const weights = new Array<number>(8).fill(0)
  let h = hue % 360
  if (h < 0) {
    h += 360
  }
  for (let i = 0; i < 8; i++) {
    const c0 = HUE_RANGE_CENTRES[i] ?? 0
    const c1 = i === 7 ? 360 : HUE_RANGE_CENTRES[i + 1] ?? 360
    if (h >= c0 && h < c1) {
      const t = (h - c0) / (c1 - c0)
      weights[i] = 1 - t
      weights[i === 7 ? 0 : i + 1] = t
      return weights
    }
  }
  return weights
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const maxC = Math.max(r, g, b)
  const minC = Math.min(r, g, b)
  const delta = maxC - minC
  const l = (maxC + minC) / 2
  if (delta <= 0) {
    return { h: 0, s: 0, l }
  }
  const s = l > 0.5 ? delta / (2 - maxC - minC) : delta / (maxC + minC)
  let h = maxC === r ? (g - b) / delta + (g < b ? 6 : 0) : maxC === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  h = h * 60
  if (h >= 360) {
    h -= 360
  }
  return { h, s, l }
}

function hueToRgb(p: number, q: number, t: number): number {
  if (t < 0) {
    t += 1
  }
  if (t > 1) {
    t -= 1
  }
  if (t < 1 / 6) {
    return p + (q - p) * 6 * t
  }
  if (t < 0.5) {
    return q
  }
  if (t < 2 / 3) {
    return p + (q - p) * (2 / 3 - t) * 6
  }
  return p
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 0) {
    return [l, l, l]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hk = h / 360
  return [hueToRgb(p, q, hk + 1 / 3), hueToRgb(p, q, hk), hueToRgb(p, q, hk - 1 / 3)]
}

/** One pixel, channels 0 .. 1 in and out. */
export function adjustPixel(profile: AssetColorProfile, r0: number, g0: number, b0: number): [number, number, number] {
  let r = r0
  let g = g0
  let b = b0
  if (profile.exposure !== 0) {
    const gain = Math.pow(2, profile.exposure)
    r *= gain
    g *= gain
    b *= gain
  }
  if (profile.blacks !== 0 || profile.whites !== 0) {
    const blackPoint = (-profile.blacks / 100) * END_POINT_RANGE
    const whitePoint = 1 - (profile.whites / 100) * END_POINT_RANGE
    const span = Math.max(whitePoint - blackPoint, 0.2)
    r = (r - blackPoint) / span
    g = (g - blackPoint) / span
    b = (b - blackPoint) / span
  }
  if (profile.contrast !== 0) {
    const factor = Math.max(1 + profile.contrast / 100, 0)
    r = (r - 0.5) * factor + 0.5
    g = (g - 0.5) * factor + 0.5
    b = (b - 0.5) * factor + 0.5
  }
  r = clamp01(r)
  g = clamp01(g)
  b = clamp01(b)
  {
    const lum = luminance(r, g, b)
    const wShadows = (1 - lum) * (1 - lum)
    const wHighlights = lum * lum
    const wMidtones = 1 - wShadows - wHighlights
    const pairs: Array<[number, AssetColorProfile['shadows']]> = [
      [wShadows, profile.shadows],
      [wMidtones, profile.midtones],
      [wHighlights, profile.highlights],
    ]
    for (const [weight, tone] of pairs) {
      if (tone.luminance === 0 && tone.r === 0 && tone.g === 0 && tone.b === 0) {
        continue
      }
      const lift = ((weight * tone.luminance) / 100) * 0.5
      r += lift + ((weight * tone.r) / 100) * 0.35
      g += lift + ((weight * tone.g) / 100) * 0.35
      b += lift + ((weight * tone.b) / 100) * 0.35
    }
    r = clamp01(r)
    g = clamp01(g)
    b = clamp01(b)
  }
  if (profile.saturation !== 0) {
    const lum = luminance(r, g, b)
    const factor = Math.max(1 + profile.saturation / 100, 0)
    r = clamp01(lum + (r - lum) * factor)
    g = clamp01(lum + (g - lum) * factor)
    b = clamp01(lum + (b - lum) * factor)
  }
  hues: {
    let anyHue = false
    for (const name of HUE_RANGE_NAMES) {
      const hue = profile.hues[name]
      if (hue.hue !== 0 || hue.saturation !== 0 || hue.luminance !== 0) {
        anyHue = true
        break
      }
    }
    if (!anyHue) {
      break hues
    }
    const hsl = rgbToHsl(r, g, b)
    if (hsl.s <= 0.001) {
      break hues
    }
    const weights = hueWeights(hsl.h)
    let hueShift = 0
    let satScale = 0
    let lumShift = 0
    HUE_RANGE_NAMES.forEach((name, i) => {
      const weight = weights[i] ?? 0
      if (weight === 0) {
        return
      }
      const hue = profile.hues[name]
      hueShift += weight * hue.hue
      satScale += (weight * hue.saturation) / 100
      lumShift += (weight * hue.luminance) / 100
    })
    const h = hsl.h + hueShift
    const s = clamp01(hsl.s * Math.max(1 + satScale, 0))
    // Luminance moves only colored pixels: a grey has no hue to belong to.
    const l = clamp01(hsl.l + lumShift * 0.3 * hsl.s)
    const rgb = hslToRgb(h, s, l)
    r = clamp01(rgb[0])
    g = clamp01(rgb[1])
    b = clamp01(rgb[2])
  }
  return [r, g, b]
}

export interface AutoEndPoints {
  whites: number
  blacks: number
}

/**
 * The Auto preset: the white and black points that map the photo's
 * luminance (percentiles 0.5 and 99.5 of the RGBA pixels as the panel will
 * show them) onto the darkest and brightest luminance of the palette it is
 * dithered to. Expressed as the Whites / Blacks sliders, so the saved
 * profile is plain sliders and the runtime has no histogram to run. Null
 * for a flat image, or one whose range already fits.
 */
export function autoEndPoints(
  pixels: Uint8ClampedArray | Uint8Array,
  palette: RgbTriplet[] | null
): AutoEndPoints | null {
  const total = Math.floor(pixels.length / 4)
  if (total <= 0) {
    return null
  }
  const histogram = new Int32Array(256)
  for (let i = 0; i < total; i++) {
    const lum = luminance(pixels[i * 4] ?? 0, pixels[i * 4 + 1] ?? 0, pixels[i * 4 + 2] ?? 0)
    const level = Math.max(0, Math.min(255, Math.round(lum)))
    histogram[level] = (histogram[level] ?? 0) + 1
  }
  const loCount = Math.floor(total * 0.005)
  const hiCount = Math.floor(total * 0.995)
  let seen = 0
  let lo = 0
  let hi = 255
  let loFound = false
  for (let level = 0; level <= 255; level++) {
    seen += histogram[level] ?? 0
    if (!loFound && seen > loCount) {
      lo = level
      loFound = true
    }
    if (seen >= hiCount) {
      hi = level
      break
    }
  }
  if (hi - lo < 3) {
    return null
  }
  const src = { lo: lo / 255, hi: hi / 255 }
  const dst = paletteRange(palette)
  // v' = dstLo + (v - srcLo) * scale, written as the sliders' (v - bp) / span.
  const scale = (dst.hi - dst.lo) / (src.hi - src.lo)
  const span = 1 / scale
  const blackPoint = src.lo - dst.lo / scale
  const whitePoint = blackPoint + span
  const clampSlider = (value: number): number => Math.max(-100, Math.min(100, Math.round(value)))
  return {
    blacks: clampSlider((-blackPoint / END_POINT_RANGE) * 100),
    whites: clampSlider(((1 - whitePoint) / END_POINT_RANGE) * 100),
  }
}

/**
 * Adjusts RGBA pixels in place. Alpha is kept; the colors are taken as
 * straight, like the runtime does.
 */
export function applyAssetColors(pixels: Uint8ClampedArray | Uint8Array, profile: AssetColorProfile): void {
  if (!profileHasAdjustments(profile)) {
    return
  }
  const total = Math.floor(pixels.length / 4)
  for (let i = 0; i < total; i++) {
    const offset = i * 4
    const [r, g, b] = adjustPixel(
      profile,
      (pixels[offset] ?? 0) / 255,
      (pixels[offset + 1] ?? 0) / 255,
      (pixels[offset + 2] ?? 0) / 255
    )
    pixels[offset] = Math.max(0, Math.min(255, Math.round(r * 255)))
    pixels[offset + 1] = Math.max(0, Math.min(255, Math.round(g * 255)))
    pixels[offset + 2] = Math.max(0, Math.min(255, Math.round(b * 255)))
  }
}
