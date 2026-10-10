/**
 * The palette a frame's panel dithers to, as far as the editor can tell from
 * the frame row: the measured tables from `frameos/src/frameos/utils/dither.nim`
 * (`spectra6ColorPalette` etc.), with a six-color custom palette on a
 * Spectra panel winning, as it does in the drivers. The device side of this
 * is `panelPaletteForDevice` in `utils/asset_colors.nim`; keep the two in
 * step. Null means "no palette dither" (full-color displays, unknown
 * hardware): the editor then previews the adjustments alone.
 */
import type { FrameType } from '../../types'
import { hexToTriplet, type RgbTriplet } from './profile'

// The Spectra 6 panels, by device name — the same set `withCustomPalette`
// in devices.ts lists, spelled as a pattern so this module (which the cloud
// typechecks through the shared-SPA tests) does not pull a component module
// in. Mirrors `panelPaletteForDevice` in utils/asset_colors.nim.
const spectraDevicePattern = /(13in3e|7in3e|4in0e|photopainter_7in3e)$|inky_impression_(4|7|13)(_2025|_spectra6)?$/

/** Measured on a Spectra panel. Index 4 is the placeholder the device skips. */
export const SPECTRA6_PALETTE: RgbTriplet[] = [
  [25, 20, 38],
  [178, 193, 192],
  [199, 187, 0],
  [107, 17, 25],
  [999, 999, 999],
  [24, 83, 154],
  [42, 85, 49],
]

export const SATURATED7_PALETTE: RgbTriplet[] = [
  [57, 48, 57],
  [255, 255, 255],
  [58, 91, 70],
  [61, 59, 94],
  [156, 72, 75],
  [208, 190, 71],
  [177, 106, 73],
]

export const SATURATED4_PALETTE: RgbTriplet[] = [
  [57, 48, 57],
  [255, 255, 255],
  [208, 190, 71],
  [156, 72, 75],
]

export const BLACK_WHITE_PALETTE: RgbTriplet[] = [
  [0, 0, 0],
  [255, 255, 255],
]

function greyPalette(levels: number): RgbTriplet[] {
  return Array.from({ length: levels }, (_, i) => {
    const value = Math.round((i * 255) / (levels - 1))
    return [value, value, value] as RgbTriplet
  })
}

export type PanelPaletteKind =
  | 'spectra6'
  | 'sevenColor'
  | 'fourColor'
  | 'blackWhiteRed'
  | 'blackWhiteYellow'
  | 'blackWhite'
  | 'gray4'
  | 'gray16'
  | 'none'

/** The panel family a device string belongs to, from its name alone. */
export function panelPaletteKindForDevice(device: string | null | undefined, label = ''): PanelPaletteKind {
  const name = (device || '').toLowerCase()
  const text = label.toLowerCase()
  if (!name || name === 'web_only' || name === 'framebuffer' || name.startsWith('pimoroni.hyperpixel')) {
    return 'none'
  }
  if (spectraDevicePattern.test(name) || text.includes('spectra')) {
    return 'spectra6'
  }
  if (
    /7in3f|5in65f|4in01f|inky_impression_4_7_color|inky_impression_5_7|inky_impression_7_3/.test(name) ||
    name === 'pimoroni.inky_impression' ||
    /7[ -]colou?r/.test(text)
  ) {
    return 'sevenColor'
  }
  if (/^waveshare\..*g$/.test(name) || /inky_(phat|what)_4$/.test(name) || text.includes('yellow/red')) {
    return 'fourColor'
  }
  if (text.includes('16 grayscale')) {
    return 'gray16'
  }
  if (text.includes('4 grayscale')) {
    return 'gray4'
  }
  if (text.includes('/red') || /_red(_ht)?$/.test(name) || /^waveshare\..*b(_v\d+)?$/.test(name)) {
    return 'blackWhiteRed'
  }
  if (text.includes('/yellow') || /_yellow$/.test(name) || /^waveshare\..*c$/.test(name)) {
    return 'blackWhiteYellow'
  }
  if (name.startsWith('waveshare.') || name.startsWith('pimoroni.inky') || name.startsWith('oled.')) {
    return 'blackWhite'
  }
  return 'none'
}

export function paletteForKind(kind: PanelPaletteKind, custom?: RgbTriplet[] | null): RgbTriplet[] | null {
  switch (kind) {
    case 'spectra6':
      return custom && custom.length === 6
        ? [...custom.slice(0, 4), [999, 999, 999], ...custom.slice(4)]
        : SPECTRA6_PALETTE
    case 'sevenColor':
      return SATURATED7_PALETTE
    case 'fourColor':
      return SATURATED4_PALETTE
    case 'blackWhiteRed':
      return [
        [0, 0, 0],
        [255, 0, 0],
        [255, 255, 255],
      ]
    case 'blackWhiteYellow':
      return [
        [0, 0, 0],
        [255, 255, 0],
        [255, 255, 255],
      ]
    case 'blackWhite':
      return BLACK_WHITE_PALETTE
    case 'gray4':
      return greyPalette(4)
    case 'gray16':
      return greyPalette(16)
    default:
      return null
  }
}

/** Without the placeholder entry: what an editor shows and a sidecar stores. */
export function visiblePalette(palette: RgbTriplet[] | null): RgbTriplet[] {
  return (palette || []).filter(([r]) => r < 999)
}

/** The six colors of a frame's custom Spectra palette, when it has one. */
export function customPaletteOf(frame: Pick<FrameType, 'palette'>): RgbTriplet[] | null {
  const colors = frame.palette?.colors
  if (!colors || colors.length !== 6) {
    return null
  }
  const triplets = colors.map(hexToTriplet)
  return triplets.every((triplet): triplet is RgbTriplet => triplet !== null) ? triplets : null
}

/**
 * `deviceLabel` is the catalog label ("… 4 Grayscale", "… 7 Color"), which
 * tells the greyscale and seven-color families apart where the name alone
 * does not; the caller looks it up (devices.ts) so this module stays free
 * of UI imports.
 */
export function panelPaletteForFrame(
  frame: Pick<FrameType, 'device' | 'palette' | 'device_config' | 'embedded'>,
  deviceLabel = ''
): RgbTriplet[] | null {
  if (frame.embedded?.platform === 'virtual') {
    const mode = frame.device_config?.colorMode
    const kind: PanelPaletteKind =
      mode === 'spectra6'
        ? 'spectra6'
        : mode === 'sevencolor'
        ? 'sevenColor'
        : mode === 'bwyr'
        ? 'fourColor'
        : mode === 'gray4'
        ? 'gray4'
        : mode === 'bw'
        ? 'blackWhite'
        : 'none'
    return paletteForKind(kind, customPaletteOf(frame))
  }
  return paletteForKind(panelPaletteKindForDevice(frame.device, deviceLabel), customPaletteOf(frame))
}
