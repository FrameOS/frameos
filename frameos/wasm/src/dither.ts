// What a frame's picture actually looks like on an e-ink panel.
//
// The browser preview renders in full colour; the panel gets six inks, or
// four greys, or two. This module is the same Floyd–Steinberg the device
// runs (frameos/src/frameos/utils/dither.nim — `forEachPaletteDithered` and
// `forEachGrayDithered`), ported number for number so what the preview shows
// is what the driver would push: the measured panel colours, the integer
// `div 16` error split clipped into the neighbour at each step, and the
// threshold jitter that keeps gradients from banding.
//
// Display only. Nothing here changes what the scene renders — it re-colours
// the finished frame the way the panel would.

/** A palette measured off a real display; the same tuples dither.nim holds. */
type Rgb = readonly [number, number, number]

// 4-colour screens (black / white / yellow / red), as measured.
const saturated4ColorPalette: readonly Rgb[] = [
  [57, 48, 57],
  [255, 255, 255],
  [208, 190, 71],
  [156, 72, 75],
]

// 6-colour Spectra e-ink, measured on display and modulated. Index 4 is a
// hole in the panel's own encoding — kept so the indices line up with the
// device, and unreachable because nothing is that close to (999, 999, 999).
const spectra6ColorPalette: readonly Rgb[] = [
  [25, 20, 38], // 0x0 - black
  [178, 193, 192], // 0x1 - white
  [199, 187, 0], // 0x2 - yellow
  [107, 17, 25], // 0x3 - red
  [999, 999, 999], // skips an index!
  [24, 83, 154], // 0x5 - blue
  [42, 85, 49], // 0x6 - green
]

// 7-colour (ACeP) screens, as measured on a real display.
const saturated7ColorPalette: readonly Rgb[] = [
  [57, 48, 57], // dark gray
  [255, 255, 255], // white
  [58, 91, 70], // khaki green
  [61, 59, 94], // dark purple
  [156, 72, 75], // red
  [208, 190, 71], // yellow
  [177, 106, 73], // orange-brown
]

/** The panel kinds a preview can be shown through. */
export type PanelPaletteKey =
  | 'spectra6'
  | 'sevenColor'
  | 'fourColor'
  | 'blackWhiteRed'
  | 'blackWhiteYellow'
  | 'sixteenGray'
  | 'fourGray'
  | 'blackWhite'

type PanelPalette =
  | { readonly key: PanelPaletteKey; readonly label: string; readonly colors: readonly Rgb[] }
  | { readonly key: PanelPaletteKey; readonly label: string; readonly grayLevels: number }

/** In the order the picker offers them: colour panels first, then greys. */
export const panelPalettes: readonly PanelPalette[] = [
  { key: 'spectra6', label: 'Spectra 6', colors: spectra6ColorPalette },
  { key: 'sevenColor', label: '7 colour (ACeP)', colors: saturated7ColorPalette },
  { key: 'fourColor', label: 'Black / white / yellow / red', colors: saturated4ColorPalette },
  {
    key: 'blackWhiteRed',
    label: 'Black / white / red',
    colors: [
      [0, 0, 0],
      [255, 0, 0],
      [255, 255, 255],
    ],
  },
  {
    key: 'blackWhiteYellow',
    label: 'Black / white / yellow',
    colors: [
      [0, 0, 0],
      [255, 255, 0],
      [255, 255, 255],
    ],
  },
  { key: 'sixteenGray', label: '16 greys', grayLevels: 15 },
  { key: 'fourGray', label: '4 greys', grayLevels: 3 },
  { key: 'blackWhite', label: 'Black & white', grayLevels: 1 },
]

export function panelPaletteFor(key: string | null | undefined): PanelPalette | null {
  return panelPalettes.find((palette) => palette.key === key) ?? null
}

/** dither.nim's DitherJitterDefaultAmp: 8 eight-bit units. */
const JITTER_AMP = 8

/** dither.nim's `ditherJitterFor`: a deterministic offset in [-amp, amp]
 *  hashed from the flat pixel index, so the quantiser's choice never locks
 *  into the periodic "worm" textures a smooth input otherwise produces. */
function jitterFor(index: number): number {
  return (((Math.imul(index, 0x9e3779b1) >>> 24) * (2 * JITTER_AMP + 1)) >> 8) - JITTER_AMP
}

function clip8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

/**
 * Re-colours an RGBA frame in place the way `panel` would show it. Alpha is
 * left alone; the runtime hands us opaque frames, the same picture the
 * driver dithers.
 */
export function ditherFrame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  panel: PanelPalette,
): void {
  if (width <= 0 || height <= 0) {
    return
  }
  if ('grayLevels' in panel) {
    ditherToGrays(data, width, height, panel.grayLevels)
  } else {
    ditherToPalette(data, width, height, panel.colors)
  }
}

// forEachPaletteDithered: two rows of error-adjusted 8-bit RGB, a
// first-minimum Manhattan search for the nearest ink, and the error split
// with integer `div 16` — truncating, as Nim's `div` does — clipped into
// each neighbour as it is pushed.
function ditherToPalette(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  palette: readonly Rgb[],
): void {
  const count = palette.length
  const palR = new Int32Array(count)
  const palG = new Int32Array(count)
  const palB = new Int32Array(count)
  for (let i = 0; i < count; i += 1) {
    palR[i] = palette[i]![0]
    palG[i] = palette[i]![1]
    palB[i] = palette[i]![2]
  }

  let curRow = new Uint8Array(width * 3)
  let nextRow = new Uint8Array(width * 3)
  const loadRow = (row: Uint8Array, y: number) => {
    let source = y * width * 4
    for (let x = 0; x < width; x += 1) {
      row[x * 3 + 0] = data[source]!
      row[x * 3 + 1] = data[source + 1]!
      row[x * 3 + 2] = data[source + 2]!
      source += 4
    }
  }
  const push = (row: Uint8Array, x: number, er: number, eg: number, eb: number, weight: number) => {
    const at = x * 3
    row[at] = clip8(row[at]! + Math.trunc((er * weight) / 16))
    row[at + 1] = clip8(row[at + 1]! + Math.trunc((eg * weight) / 16))
    row[at + 2] = clip8(row[at + 2]! + Math.trunc((eb * weight) / 16))
  }

  loadRow(curRow, 0)
  for (let y = 0; y < height; y += 1) {
    const hasNext = y + 1 < height
    if (hasNext) {
      loadRow(nextRow, y + 1)
    }
    const rowIndex = y * width
    let target = rowIndex * 4
    for (let x = 0; x < width; x += 1) {
      const imageR = curRow[x * 3 + 0]!
      const imageG = curRow[x * 3 + 1]!
      const imageB = curRow[x * 3 + 2]!
      // The jitter moves only which ink is picked; the error the neighbours
      // inherit is measured against the true value, so the local mean stays
      // exact and no colour shifts.
      const jitter = jitterFor(rowIndex + x)
      const pickR = clip8(imageR + jitter)
      const pickG = clip8(imageG + jitter)
      const pickB = clip8(imageB + jitter)

      let best = 0
      let bestDistance = Number.MAX_SAFE_INTEGER
      for (let i = 0; i < count; i += 1) {
        const distance =
          Math.abs(pickR - palR[i]!) + Math.abs(pickG - palG[i]!) + Math.abs(pickB - palB[i]!)
        if (distance < bestDistance) {
          bestDistance = distance
          best = i
        }
      }

      const errorR = imageR - palR[best]!
      const errorG = imageG - palG[best]!
      const errorB = imageB - palB[best]!
      data[target] = palR[best]!
      data[target + 1] = palG[best]!
      data[target + 2] = palB[best]!
      target += 4

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
}

// forEachGrayDithered: the same walk in float, over the luminance
// `toGrayscaleFloat` computes, quantised to `maxLevel` + 1 evenly spaced
// greys. The level a driver packs is shown back as the grey it lights.
function ditherToGrays(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  maxLevel: number,
): void {
  const multiple = maxLevel
  let curRow = new Float64Array(width)
  let nextRow = new Float64Array(width)
  const loadRow = (row: Float64Array, y: number) => {
    let source = y * width * 4
    for (let x = 0; x < width; x += 1) {
      row[x] =
        (multiple * (data[source]! * 0.21 + data[source + 1]! * 0.72 + data[source + 2]! * 0.07)) /
        255.0
      source += 4
    }
  }

  loadRow(curRow, 0)
  const jitterUnit = multiple / 255.0
  for (let y = 0; y < height; y += 1) {
    const hasNext = y + 1 < height
    if (hasNext) {
      loadRow(nextRow, y + 1)
    }
    let target = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const jitter = jitterFor(y * width + x) * jitterUnit
      // Nim's `round` is half away from zero; these values are never
      // negative enough for the difference to show, but keep the shape.
      const value = Math.round(curRow[x]! + jitter)
      const error = curRow[x]! - value
      const level = Math.max(0, Math.min(maxLevel, value))
      const shade = Math.round((level / maxLevel) * 255)
      data[target] = shade
      data[target + 1] = shade
      data[target + 2] = shade
      target += 4

      if (x + 1 < width) {
        curRow[x + 1]! += error * (7.0 / 16.0)
      }
      if (hasNext) {
        if (x - 1 >= 0) {
          nextRow[x - 1]! += error * (3.0 / 16.0)
        }
        nextRow[x]! += error * (5.0 / 16.0)
        if (x + 1 < width) {
          nextRow[x + 1]! += error * (1.0 / 16.0)
        }
      }
    }
    const swap = curRow
    curRow = nextRow
    nextRow = swap
  }
}
