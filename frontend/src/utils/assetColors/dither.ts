/**
 * The panel dither, ported from `forEachPaletteDithered` in
 * `frameos/src/frameos/utils/dither.nim` so the Assets panel can show what a
 * photo will look like on the panel: Floyd–Steinberg with integer error
 * split by `div 16` (truncating), clipped into the neighbour at every step,
 * first-minimum Manhattan palette search, and a per-pixel threshold jitter
 * on the pick only (amplitude 8). The runtime's test pins the index vector
 * this must reproduce (`test_asset_colors.nim`, "dither parity vector").
 */
import type { RgbTriplet } from './profile'

export const DITHER_JITTER_DEFAULT_AMP = 8

/**
 * Deterministic per-pixel offset in [-amp, amp], hashed from the flat pixel
 * index: `((((index.uint32 * 0x9E3779B1'u32) shr 24).int * (2 * amp + 1)) shr 8) - amp`.
 */
export function ditherJitterFor(index: number, amp: number): number {
  const hash = Math.imul(index >>> 0, 0x9e3779b1) >>> 24
  return ((hash * (2 * amp + 1)) >> 8) - amp
}

function clip8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

/**
 * Runs the dither over RGBA pixels and returns the palette index of every
 * pixel in scan order. Entries with a channel of 999 (the Spectra table's
 * placeholder) are never picked, exactly as on the device.
 */
export function ditherPaletteIndices(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  palette: RgbTriplet[],
  jitterAmp = DITHER_JITTER_DEFAULT_AMP
): Uint8Array {
  const indices = new Uint8Array(Math.max(0, width * height))
  if (width <= 0 || height <= 0 || palette.length === 0) {
    return indices
  }
  const paletteLen = palette.length
  const palR = new Int32Array(paletteLen)
  const palG = new Int32Array(paletteLen)
  const palB = new Int32Array(paletteLen)
  palette.forEach(([r, g, b], i) => {
    palR[i] = r
    palG[i] = g
    palB[i] = b
  })
  // The adjusted RGB of the current row and the next: the pixel values after
  // the error already pushed into them.
  let curRow = new Int32Array(width * 3)
  let nextRow = new Int32Array(width * 3)
  const loadRow = (row: Int32Array, y: number): void => {
    const start = y * width * 4
    for (let x = 0; x < width; x++) {
      row[x * 3] = pixels[start + x * 4] ?? 0
      row[x * 3 + 1] = pixels[start + x * 4 + 1] ?? 0
      row[x * 3 + 2] = pixels[start + x * 4 + 2] ?? 0
    }
  }
  const push = (row: Int32Array, x: number, er: number, eg: number, eb: number, weight: number): void => {
    // `div 16` truncates toward zero; `| 0` does the same for these magnitudes.
    row[x * 3] = clip8((row[x * 3] ?? 0) + (((er * weight) / 16) | 0))
    row[x * 3 + 1] = clip8((row[x * 3 + 1] ?? 0) + (((eg * weight) / 16) | 0))
    row[x * 3 + 2] = clip8((row[x * 3 + 2] ?? 0) + (((eb * weight) / 16) | 0))
  }
  loadRow(curRow, 0)
  for (let y = 0; y < height; y++) {
    const hasNext = y + 1 < height
    if (hasNext) {
      loadRow(nextRow, y + 1)
    }
    const rowIndex = y * width
    for (let x = 0; x < width; x++) {
      const imageR = curRow[x * 3] ?? 0
      const imageG = curRow[x * 3 + 1] ?? 0
      const imageB = curRow[x * 3 + 2] ?? 0
      // The jitter moves only which palette colour is picked; the error the
      // neighbours inherit is measured against the true value.
      const jitter = jitterAmp > 0 ? ditherJitterFor(rowIndex + x, jitterAmp) : 0
      const pickR = clip8(imageR + jitter)
      const pickG = clip8(imageG + jitter)
      const pickB = clip8(imageB + jitter)
      let palIndex = 0
      let bestDistance = Number.MAX_SAFE_INTEGER
      for (let i = 0; i < paletteLen; i++) {
        const distance =
          Math.abs(pickR - (palR[i] ?? 0)) + Math.abs(pickG - (palG[i] ?? 0)) + Math.abs(pickB - (palB[i] ?? 0))
        if (distance < bestDistance) {
          bestDistance = distance
          palIndex = i
        }
      }
      const errorR = imageR - (palR[palIndex] ?? 0)
      const errorG = imageG - (palG[palIndex] ?? 0)
      const errorB = imageB - (palB[palIndex] ?? 0)
      indices[rowIndex + x] = palIndex
      if (x + 1 < width) {
        push(curRow, x + 1, errorR, errorG, errorB, 7)
      }
      if (hasNext) {
        if (x - 1 >= 0) {
          push(nextRow, x - 1, errorR, errorG, errorB, 3)
        }
        push(nextRow, x, errorR, errorG, errorB, 5)
        if (x + 1 < width) {
          push(nextRow, x + 1, errorR, errorG, errorB, 1)
        }
      }
    }
    const swap = curRow
    curRow = nextRow
    nextRow = swap
  }
  return indices
}

/**
 * Dithers RGBA pixels to the palette and paints the result as the palette's
 * own colours (what the panel shows) into `out`, which may be `pixels`.
 */
export function ditherToPalette(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  palette: RgbTriplet[],
  out: Uint8ClampedArray | Uint8Array = pixels,
  jitterAmp = DITHER_JITTER_DEFAULT_AMP
): void {
  const indices = ditherPaletteIndices(pixels, width, height, palette, jitterAmp)
  for (let i = 0; i < indices.length; i++) {
    const [r, g, b] = palette[indices[i] ?? 0] ?? [0, 0, 0]
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 255
  }
}
