import { devices } from '../../devices'
import type { FrameType } from '../../types'
import { type AutoEndPoints, applyAssetColors, autoEndPoints } from './adjust'
import { visiblePalette } from './devicePalette'
import { ditherToPalette } from './dither'
import { type AssetColorProfile, type RgbTriplet, defaultAssetColorProfile } from './profile'

// The "Set colors" editor's preview arithmetic: a photo placed on a
// panel-sized canvas, graded, dithered. Pure, with the caller's canvases;
// the Assets panel (assetColorsLogic) and the Photos library
// (scenes/photos/photoColors.ts) both paint with it.

export type PreviewFit = 'cover' | 'contain'

/** None: every slider neutral. Auto: the Auto preset's end points and nothing else. Custom: anything else. */
export type AdjustmentMode = 'none' | 'auto' | 'custom'

/** What the editor paints: the photo scaled onto a canvas the size of the panel. */
export interface PreviewSource {
  bitmap: ImageBitmap
  width: number
  height: number
}

/** The profile the Auto preset produces: the end points, everything else neutral, the palette kept. */
export function autoProfileFor(profile: AssetColorProfile, endPoints: AutoEndPoints): AssetColorProfile {
  return { ...defaultAssetColorProfile(), palette: profile.palette, whites: endPoints.whites, blacks: endPoints.blacks }
}

/** The catalog label for a device value ("Waveshare 7.3\" (E) 800x480 Spectra 6 Color"). */
export function deviceLabelFor(device: string | null | undefined): string {
  if (!device) {
    return ''
  }
  for (const group of devices) {
    for (const option of group.options) {
      if (option.value === device) {
        return option.label
      }
    }
  }
  return ''
}

/** The panel's render size in scene space (a rotated panel swaps the two). */
export function panelRenderSize(frame: Pick<FrameType, 'width' | 'height' | 'rotate'>): {
  width: number
  height: number
} {
  const width = Math.max(1, Math.round(Number(frame.width) || 800))
  const height = Math.max(1, Math.round(Number(frame.height) || 480))
  const rotate = Number(frame.rotate) || 0
  return rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height }
}

/**
 * The photo drawn onto a panel-sized canvas, as the frame's image app would
 * place it (cover crops to fill; contain letterboxes on black).
 */
export function drawPreviewSource(
  context: CanvasRenderingContext2D,
  source: PreviewSource,
  width: number,
  height: number,
  fit: PreviewFit
): void {
  context.fillStyle = '#000000'
  context.fillRect(0, 0, width, height)
  const scale =
    fit === 'cover'
      ? Math.max(width / source.width, height / source.height)
      : Math.min(width / source.width, height / source.height)
  const drawWidth = source.width * scale
  const drawHeight = source.height * scale
  context.drawImage(source.bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
}

/** The Auto preset for the photo as the panel will show it (placed, at panel size). */
export function computeAutoEndPoints(
  work: HTMLCanvasElement,
  source: PreviewSource,
  options: { width: number; height: number; fit: PreviewFit; palette: RgbTriplet[] | null }
): AutoEndPoints | null {
  const { width, height, fit, palette } = options
  work.width = width
  work.height = height
  const context = work.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return null
  }
  drawPreviewSource(context, source, width, height, fit)
  return autoEndPoints(context.getImageData(0, 0, width, height).data, palette)
}

/**
 * The panel-sized preview: the photo placed, the profile applied, and (when
 * asked) dithered to the palette the panel will show — the same arithmetic
 * the runtime runs (utils/assetColors). Pure: the caller owns the canvases.
 */
export function renderColorPreview(
  work: HTMLCanvasElement,
  source: PreviewSource,
  options: {
    width: number
    height: number
    fit: PreviewFit
    profile: AssetColorProfile
    panelPalette: RgbTriplet[] | null
    dithered: boolean
    adjusted: boolean
    /** The frame's fine tuning (`colors.global`), run on the finished frame after the photo's own. */
    globalProfile?: AssetColorProfile | null
  }
): ImageData | null {
  const { width, height, fit, profile, panelPalette, dithered, adjusted, globalProfile } = options
  work.width = width
  work.height = height
  const context = work.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return null
  }
  drawPreviewSource(context, source, width, height, fit)
  const imageData = context.getImageData(0, 0, width, height)
  if (adjusted) {
    applyAssetColors(imageData.data, profile)
  }
  if (globalProfile) {
    applyAssetColors(imageData.data, globalProfile)
  }
  const palette = profile.palette && profile.palette.length > 0 ? profile.palette : visiblePalette(panelPalette)
  if (dithered && palette.length > 0) {
    ditherToPalette(imageData.data, width, height, palette)
  }
  return imageData
}
