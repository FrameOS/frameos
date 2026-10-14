import type { FrameType } from '../../types'
import { applyAssetColors, autoEndPoints } from '../../utils/assetColors/adjust'
import {
  type PanelPaletteKind,
  autoFitByDefaultForKind,
  paletteDeviceOf,
  paletteForKind,
  panelAutoFitByDefault,
  panelPaletteForFrame,
  visiblePalette,
} from '../../utils/assetColors/devicePalette'
import { ditherToPalette } from '../../utils/assetColors/dither'
import {
  type AssetColorProfile,
  type RgbTriplet,
  defaultAssetColorProfile,
  parseAssetColorProfile,
  profileHasAdjustments,
  serializeAssetColorProfile,
} from '../../utils/assetColors/profile'
import {
  type PreviewFit,
  type PreviewSource,
  deviceLabelFor,
  drawPreviewSource,
  panelRenderSize,
} from '../../utils/assetColors/preview'
import type { PhotoColors } from './photosApi'

/** A photo's `colors` → the editor's profile, or null when it has none. */
export function profileOfPhotoColors(colors: PhotoColors | null | undefined): AssetColorProfile | null {
  return colors ? parseAssetColorProfile({ version: 1, colors }) : null
}

/** The editor's profile → what `POST /api/photos/colors` stores; null when every slider is neutral. */
export function photoColorsOfProfile(profile: AssetColorProfile): PhotoColors | null {
  const { colors } = JSON.parse(serializeAssetColorProfile(profile)) as { colors?: PhotoColors }
  return colors && Object.keys(colors).length > 0 ? colors : null
}

/**
 * Where a photo is previewed: at full fidelity, or as one panel shows it:
 * scaled to its size, graded, dithered to its palette. A frame brings its
 * own panel, size, automatic fit and fine tuning; a panel family is that
 * family's palette at 800×480.
 */
export interface PhotoPreviewTarget {
  key: string
  label: string
  group: 'original' | 'frames' | 'panels'
  /** The dither table, Spectra placeholder included; null for full color. */
  palette: RgbTriplet[] | null
  width: number
  height: number
  autoFit: boolean
  /** The frame's fine tuning (`colors.global`), when it has any. */
  global: AssetColorProfile | null
}

export const FULL_FIDELITY_TARGET: PhotoPreviewTarget = {
  key: 'original',
  label: 'Full fidelity',
  group: 'original',
  palette: null,
  width: 0,
  height: 0,
  autoFit: false,
  global: null,
}

const PANEL_FAMILIES: [PanelPaletteKind, string][] = [
  ['spectra6', 'Spectra 6'],
  ['sevenColor', '7 colors'],
  ['fourColor', 'Black, white, yellow and red'],
  ['blackWhiteRed', 'Black, white and red'],
  ['blackWhiteYellow', 'Black, white and yellow'],
  ['blackWhite', 'Black and white'],
  ['gray4', '4 grays'],
  ['gray16', '16 grays'],
]

const PANEL_FAMILY_SIZE = { width: 800, height: 480 }

/** The longest side a full-fidelity preview is painted at. */
export const FULL_FIDELITY_MAX_SIDE = 3200

function frameTarget(frame: FrameType): PhotoPreviewTarget {
  const deviceLabel = deviceLabelFor(paletteDeviceOf(frame))
  const mode = frame.colors?.autoFit ?? 'default'
  const global = parseAssetColorProfile({ version: 1, colors: frame.colors?.global ?? {} })
  return {
    key: `frame:${frame.id}`,
    label: frame.name || `Frame ${frame.id}`,
    group: 'frames',
    palette: panelPaletteForFrame(frame, deviceLabel),
    ...panelRenderSize(frame),
    autoFit: mode === 'on' || (mode !== 'off' && panelAutoFitByDefault(frame, deviceLabel)),
    global: global && profileHasAdjustments(global) ? { ...global, palette: null } : null,
  }
}

export function photoPreviewTargets(frames: FrameType[]): PhotoPreviewTarget[] {
  return [
    FULL_FIDELITY_TARGET,
    ...frames.filter((frame) => !frame.archived).map(frameTarget),
    ...PANEL_FAMILIES.map(
      ([kind, label]): PhotoPreviewTarget => ({
        key: `panel:${kind}`,
        label,
        group: 'panels',
        palette: paletteForKind(kind),
        ...PANEL_FAMILY_SIZE,
        autoFit: autoFitByDefaultForKind(kind),
        global: null,
      })
    ),
  ]
}

/** The canvas size a target paints the photo at. */
export function previewSizeFor(
  target: PhotoPreviewTarget,
  source: { width: number; height: number }
): { width: number; height: number } {
  if (target.group !== 'original') {
    return { width: target.width, height: target.height }
  }
  const scale = Math.min(1, FULL_FIDELITY_MAX_SIDE / Math.max(source.width, source.height, 1))
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  }
}

/**
 * The photo as `target` shows it, in the runtime's order: placed at the
 * panel's size, graded by its own profile (else the panel's automatic fit),
 * the frame's fine tuning on top, then dithered to the photo's palette or
 * the panel's. At full fidelity: its own size, its own profile, no dither.
 */
export function renderPhotoPreview(
  work: HTMLCanvasElement,
  source: PreviewSource,
  options: { target: PhotoPreviewTarget; fit: PreviewFit; colors: PhotoColors | null | undefined }
): ImageData | null {
  const { target, colors } = options
  const { width, height } = previewSizeFor(target, source)
  const fit = target.group === 'original' ? 'contain' : options.fit
  work.width = width
  work.height = height
  const context = work.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return null
  }
  drawPreviewSource(context, source, width, height, fit)
  const imageData = context.getImageData(0, 0, width, height)
  const profile = profileOfPhotoColors(colors)
  const palette = profile?.palette?.length ? profile.palette : visiblePalette(target.palette)
  if (profile && profileHasAdjustments(profile)) {
    applyAssetColors(imageData.data, profile)
  } else if (target.autoFit) {
    const endPoints = autoEndPoints(imageData.data, palette.length > 0 ? palette : null)
    if (endPoints) {
      applyAssetColors(imageData.data, { ...defaultAssetColorProfile(), ...endPoints })
    }
  }
  if (target.global) {
    applyAssetColors(imageData.data, target.global)
  }
  if (target.group !== 'original' && palette.length > 0) {
    ditherToPalette(imageData.data, width, height, palette)
  }
  return imageData
}
