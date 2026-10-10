import { MakeLogicType, actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import { frameLogic } from '../../frameLogic'
import { assetsLogic } from './assetsLogic'
import { assetPathKey } from './assetPaths'
import { frameAssetUrl } from '../../../../utils/frameAssetsApi'
import { devices } from '../../../../devices'
import { type AutoEndPoints, applyAssetColors, autoEndPoints } from '../../../../utils/assetColors/adjust'
import { panelPaletteForFrame, visiblePalette } from '../../../../utils/assetColors/devicePalette'
import { ditherToPalette } from '../../../../utils/assetColors/dither'
import {
  type AssetColorProfile,
  type HueRangeName,
  type RgbTriplet,
  type ToneRangeName,
  defaultAssetColorProfile,
  parseAssetColorProfile,
  profileIsDefault,
  serializeAssetColorProfile,
  sidecarPathFor,
} from '../../../../utils/assetColors/profile'
import type { AssetType, FrameId, FrameType } from '../../../../types'

export interface AssetColorsLogicProps {
  frameId: FrameId
}

export type PreviewFit = 'cover' | 'contain'

/** None: every slider neutral. Auto: the Auto preset's end points and nothing else. Custom: anything else. */
export type AdjustmentMode = 'none' | 'auto' | 'custom'

/** The profile the Auto preset produces: the end points, everything else neutral, the palette kept. */
export function autoProfileFor(profile: AssetColorProfile, endPoints: AutoEndPoints): AssetColorProfile {
  return { ...defaultAssetColorProfile(), palette: profile.palette, whites: endPoints.whites, blacks: endPoints.blacks }
}

function sameAdjustments(a: AssetColorProfile, b: AssetColorProfile): boolean {
  return serializeAssetColorProfile({ ...a, palette: null }) === serializeAssetColorProfile({ ...b, palette: null })
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

/** What the modal paints: the photo scaled onto a canvas the size of the panel. */
export interface PreviewSource {
  bitmap: ImageBitmap
  width: number
  height: number
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
  }
): ImageData | null {
  const { width, height, fit, profile, panelPalette, dithered, adjusted } = options
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
  const palette = profile.palette && profile.palette.length > 0 ? profile.palette : visiblePalette(panelPalette)
  if (dithered && palette.length > 0) {
    ditherToPalette(imageData.data, width, height, palette)
  }
  return imageData
}

async function fetchAssetBitmap(frameId: FrameId, path: string): Promise<PreviewSource> {
  const response = await fetch(frameAssetUrl(frameId, path, { mode: 'image', filename: path.split('/').pop() }), {
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error(`Could not load the image (${response.status})`)
  }
  const blob = await response.blob()
  const bitmap = await createImageBitmap(blob)
  return { bitmap, width: bitmap.width, height: bitmap.height }
}

async function fetchSidecar(frameId: FrameId, imagePath: string): Promise<AssetColorProfile | null> {
  const sidecar = sidecarPathFor(imagePath)
  const response = await fetch(
    frameAssetUrl(frameId, sidecar, { mode: 'download', filename: sidecar.split('/').pop() }),
    { credentials: 'include' }
  )
  if (!response.ok) {
    return null
  }
  try {
    return parseAssetColorProfile(JSON.parse(await response.text()))
  } catch {
    return null
  }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface assetColorsLogicValues {
  assets: AssetType[] // assetsLogic
  colorProfileKeys: Set<string> // assetsLogic
  frame: FrameType // frameLogic
  frameForm: Partial<FrameType> // frameLogic
  adjustmentMode: AdjustmentMode
  autoEndPoints: AutoEndPoints | null
  canSave: boolean
  fit: PreviewFit
  hasSavedProfile: boolean
  imagePath: string | null
  imageSize: {
    height: number
    width: number
  }
  isDefault: boolean
  isDirty: boolean
  panelPalette: RgbTriplet[] | null
  profile: AssetColorProfile
  savedProfile: AssetColorProfile | null
  savedProfileLoading: boolean
  selectedHue: HueRangeName
  selectedTone: ToneRangeName
  showAdjusted: boolean
  showDithered: boolean
  source: PreviewSource | null
  sourceError: string | null
  sourceLoading: boolean
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface assetColorsLogicActions {
  deleteAsset: (path: string) => {
    path: string
  } // assetsLogic
  uploadDroppedFiles: (
    path: string,
    files: File[]
  ) => {
    files: File[]
    path: string
  } // assetsLogic
  closeEditor: () => {
    value: true
  }
  loadSavedProfile: (imagePath: string) => string
  loadSavedProfileFailure: (
    error: string,
    errorObject?: any
  ) => {
    error: string
    errorObject?: any
  }
  loadSavedProfileSuccess: (
    savedProfile: AssetColorProfile | null,
    payload?: string
  ) => {
    savedProfile: AssetColorProfile | null
    payload?: string
  }
  loadSource: (imagePath: string) => string
  loadSourceFailure: (
    error: string,
    errorObject?: any
  ) => {
    error: string
    errorObject?: any
  }
  loadSourceSuccess: (
    source: PreviewSource | null,
    payload?: string
  ) => {
    source: PreviewSource | null
    payload?: string
  }
  openEditor: (imagePath: string) => {
    imagePath: string
  }
  recomputeAuto: () => {
    value: true
  }
  removeProfile: () => {
    value: true
  }
  resetProfile: () => {
    value: true
  }
  saveProfile: () => {
    value: true
  }
  setAdjustmentMode: (mode: AdjustmentMode) => {
    mode: AdjustmentMode
  }
  setAutoEndPoints: (autoEndPoints: AutoEndPoints | null) => {
    autoEndPoints: AutoEndPoints | null
  }
  setFit: (fit: PreviewFit) => {
    fit: PreviewFit
  }
  setHue: (
    name: HueRangeName,
    key: 'hue' | 'luminance' | 'saturation',
    value: number
  ) => {
    key: 'hue' | 'luminance' | 'saturation'
    name: 'aqua' | 'blue' | 'green' | 'magenta' | 'orange' | 'purple' | 'red' | 'yellow'
    value: number
  }
  setPalette: (palette: RgbTriplet[] | null) => {
    palette: RgbTriplet[] | null
  }
  setPaletteColor: (
    index: number,
    color: RgbTriplet
  ) => {
    color: RgbTriplet
    index: number
  }
  setProfile: (profile: AssetColorProfile) => {
    profile: AssetColorProfile
  }
  setSelectedHue: (selectedHue: HueRangeName) => {
    selectedHue: 'aqua' | 'blue' | 'green' | 'magenta' | 'orange' | 'purple' | 'red' | 'yellow'
  }
  setSelectedTone: (selectedTone: ToneRangeName) => {
    selectedTone: 'highlights' | 'midtones' | 'shadows'
  }
  setShowAdjusted: (showAdjusted: boolean) => {
    showAdjusted: boolean
  }
  setShowDithered: (showDithered: boolean) => {
    showDithered: boolean
  }
  setSlider: (
    key: 'blacks' | 'contrast' | 'exposure' | 'saturation' | 'whites',
    value: number
  ) => {
    key: 'blacks' | 'contrast' | 'exposure' | 'saturation' | 'whites'
    value: number
  }
  setTone: (
    name: ToneRangeName,
    key: 'b' | 'g' | 'luminance' | 'r',
    value: number
  ) => {
    key: 'b' | 'g' | 'luminance' | 'r'
    name: 'highlights' | 'midtones' | 'shadows'
    value: number
  }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface assetColorsLogicMeta {
  key: FrameId
  __keaTypeGenInternalSelectorTypes: {
    panelPalette: (frameForm: Partial<FrameType>, frame: FrameType) => RgbTriplet[] | null
    imageSize: (
      frameForm: Partial<FrameType>,
      frame: FrameType
    ) => {
      height: number
      width: number
    }
    hasSavedProfile: (imagePath: string | null, colorProfileKeys: Set<string>, frame: FrameType) => boolean
    isDefault: (profile: AssetColorProfile) => boolean
    adjustmentMode: (profile: AssetColorProfile, autoEndPoints: AutoEndPoints | null) => AdjustmentMode
    isDirty: (profile: AssetColorProfile, savedProfile: AssetColorProfile | null) => boolean
    canSave: (isDirty: boolean, source: PreviewSource | null, savedProfileLoading: boolean) => boolean
  }
}

export type assetColorsLogicType = MakeLogicType<
  assetColorsLogicValues,
  assetColorsLogicActions,
  AssetColorsLogicProps
> &
  assetColorsLogicMeta

/**
 * The "Set colors" editor for one photo in the Assets panel: a Lightroom-ish
 * set of sliders, previewed on a panel-sized canvas with the panel's own
 * dither, saved as the photo's `.frameos.json` sidecar (utils/assetColors).
 */
export const assetColorsLogic = kea<assetColorsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Assets', 'assetColorsLogic']),
  props({} as AssetColorsLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: AssetColorsLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm'], assetsLogic({ frameId }), ['assets', 'colorProfileKeys']],
    actions: [assetsLogic({ frameId }), ['uploadDroppedFiles', 'deleteAsset']],
  })),
  actions({
    openEditor: (imagePath: string) => ({ imagePath }),
    closeEditor: true,
    setProfile: (profile: AssetColorProfile) => ({ profile }),
    setSlider: (key: 'exposure' | 'contrast' | 'whites' | 'blacks' | 'saturation', value: number) => ({ key, value }),
    setTone: (name: ToneRangeName, key: 'luminance' | 'r' | 'g' | 'b', value: number) => ({ name, key, value }),
    setHue: (name: HueRangeName, key: 'hue' | 'saturation' | 'luminance', value: number) => ({ name, key, value }),
    setAdjustmentMode: (mode: AdjustmentMode) => ({ mode }),
    setAutoEndPoints: (autoEndPoints: AutoEndPoints | null) => ({ autoEndPoints }),
    recomputeAuto: true,
    setPalette: (palette: RgbTriplet[] | null) => ({ palette }),
    setPaletteColor: (index: number, color: RgbTriplet) => ({ index, color }),
    setSelectedTone: (selectedTone: ToneRangeName) => ({ selectedTone }),
    setSelectedHue: (selectedHue: HueRangeName) => ({ selectedHue }),
    setShowDithered: (showDithered: boolean) => ({ showDithered }),
    setShowAdjusted: (showAdjusted: boolean) => ({ showAdjusted }),
    setFit: (fit: PreviewFit) => ({ fit }),
    resetProfile: true,
    saveProfile: true,
    removeProfile: true,
  }),
  loaders(({ props, values }) => ({
    source: [
      null as PreviewSource | null,
      {
        // kea-loaders hands the action's single argument over as is.
        loadSource: async (imagePath: string, breakpoint) => {
          const source = await fetchAssetBitmap(props.frameId, imagePath)
          breakpoint()
          if (values.imagePath !== imagePath) {
            return null
          }
          return source
        },
      },
    ],
    savedProfile: [
      null as AssetColorProfile | null,
      {
        loadSavedProfile: async (imagePath: string, breakpoint) => {
          // Only when the listing says the sidecar exists: on the cloud a
          // miss means waiting on the device for a file that is not there.
          if (!values.colorProfileKeys.has(assetPathKey(imagePath, values.frame.assets_path))) {
            return null
          }
          const profile = await fetchSidecar(props.frameId, imagePath)
          breakpoint()
          return values.imagePath === imagePath ? profile : null
        },
      },
    ],
  })),
  reducers({
    imagePath: [
      null as string | null,
      {
        openEditor: (_, { imagePath }) => imagePath,
        closeEditor: () => null,
      },
    ],
    sourceError: [
      null as string | null,
      {
        openEditor: () => null,
        loadSourceFailure: (_, { error }) => error,
      },
    ],
    profile: [
      defaultAssetColorProfile(),
      {
        openEditor: () => defaultAssetColorProfile(),
        setProfile: (_, { profile }) => profile,
        loadSavedProfileSuccess: (state, { savedProfile }) => savedProfile ?? state,
        setSlider: (state, { key, value }) => ({ ...state, [key]: value }),
        setTone: (state, { name, key, value }) => ({ ...state, [name]: { ...state[name], [key]: value } }),
        setHue: (state, { name, key, value }) => ({
          ...state,
          hues: { ...state.hues, [name]: { ...state.hues[name], [key]: value } },
        }),
        setPalette: (state, { palette }) => ({ ...state, palette }),
        setPaletteColor: (state, { index, color }) => ({
          ...state,
          palette: (state.palette ?? []).map((entry, i) => (i === index ? color : entry)),
        }),
        resetProfile: () => defaultAssetColorProfile(),
      },
    ],
    autoEndPoints: [
      null as AutoEndPoints | null,
      {
        openEditor: () => null,
        setAutoEndPoints: (_, { autoEndPoints }) => autoEndPoints,
      },
    ],
    selectedTone: ['midtones' as ToneRangeName, { setSelectedTone: (_, { selectedTone }) => selectedTone }],
    selectedHue: ['red' as HueRangeName, { setSelectedHue: (_, { selectedHue }) => selectedHue }],
    showDithered: [
      true,
      { persist: true, storageKey: 'assetColorsLogic.showDithered' },
      { setShowDithered: (_, { showDithered }) => showDithered },
    ],
    showAdjusted: [true, { setShowAdjusted: (_, { showAdjusted }) => showAdjusted, openEditor: () => true }],
    fit: [
      'cover' as PreviewFit,
      { persist: true, storageKey: 'assetColorsLogic.fit' },
      { setFit: (_, { fit }) => fit },
    ],
  }),
  selectors({
    panelPalette: [
      (s) => [s.frameForm, s.frame],
      (frameForm: assetColorsLogicValues['frameForm'], frame: assetColorsLogicValues['frame']): RgbTriplet[] | null =>
        panelPaletteForFrame(
          {
            device: frameForm.device ?? frame.device,
            palette: frameForm.palette ?? frame.palette,
            device_config: frameForm.device_config ?? frame.device_config,
            embedded: frame.embedded,
          },
          deviceLabelFor(frameForm.device ?? frame.device)
        ),
    ],
    imageSize: [
      (s) => [s.frameForm, s.frame],
      (frameForm: assetColorsLogicValues['frameForm'], frame: assetColorsLogicValues['frame']) =>
        panelRenderSize({
          width: frameForm.width ?? frame.width,
          height: frameForm.height ?? frame.height,
          rotate: frameForm.rotate ?? frame.rotate,
        }),
    ],
    hasSavedProfile: [
      (s) => [s.imagePath, s.colorProfileKeys, s.frame],
      (
        imagePath: assetColorsLogicValues['imagePath'],
        colorProfileKeys: assetColorsLogicValues['colorProfileKeys'],
        frame: assetColorsLogicValues['frame']
      ): boolean => !!imagePath && colorProfileKeys.has(assetPathKey(imagePath, frame.assets_path)),
    ],
    isDefault: [(s) => [s.profile], (profile: assetColorsLogicValues['profile']): boolean => profileIsDefault(profile)],
    adjustmentMode: [
      (s) => [s.profile, s.autoEndPoints],
      (
        profile: assetColorsLogicValues['profile'],
        autoEndPoints: assetColorsLogicValues['autoEndPoints']
      ): AdjustmentMode =>
        sameAdjustments(profile, defaultAssetColorProfile())
          ? 'none'
          : autoEndPoints && sameAdjustments(profile, autoProfileFor(profile, autoEndPoints))
          ? 'auto'
          : 'custom',
    ],
    isDirty: [
      (s) => [s.profile, s.savedProfile],
      (profile: assetColorsLogicValues['profile'], savedProfile: assetColorsLogicValues['savedProfile']): boolean =>
        serializeAssetColorProfile(profile) !== serializeAssetColorProfile(savedProfile ?? defaultAssetColorProfile()),
    ],
    canSave: [
      (s) => [s.isDirty, s.source, s.savedProfileLoading],
      (
        isDirty: assetColorsLogicValues['isDirty'],
        source: assetColorsLogicValues['source'],
        savedProfileLoading: assetColorsLogicValues['savedProfileLoading']
      ): boolean => isDirty && !!source && !savedProfileLoading,
    ],
  }),
  listeners(({ actions, values, cache }) => ({
    // The Auto preset depends on the photo as placed and on the palette it
    // is dithered to, so it is recomputed when any of those change.
    loadSourceSuccess: () => actions.recomputeAuto(),
    setFit: () => actions.recomputeAuto(),
    setPalette: () => actions.recomputeAuto(),
    setPaletteColor: () => actions.recomputeAuto(),
    recomputeAuto: () => {
      const source = values.source
      if (!source || typeof document === 'undefined') {
        actions.setAutoEndPoints(null)
        return
      }
      const work: HTMLCanvasElement = (cache.autoCanvas ??= document.createElement('canvas'))
      const palette =
        values.profile.palette && values.profile.palette.length > 0
          ? values.profile.palette
          : visiblePalette(values.panelPalette)
      actions.setAutoEndPoints(
        computeAutoEndPoints(work, source, {
          width: values.imageSize.width,
          height: values.imageSize.height,
          fit: values.fit,
          palette: palette.length > 0 ? palette : null,
        })
      )
    },
    setAdjustmentMode: ({ mode }) => {
      if (mode === 'none') {
        actions.setProfile({ ...defaultAssetColorProfile(), palette: values.profile.palette })
      } else if (mode === 'auto' && values.autoEndPoints) {
        actions.setProfile(autoProfileFor(values.profile, values.autoEndPoints))
      }
      // Custom is where any slider move lands by itself.
    },
    openEditor: ({ imagePath }) => {
      actions.loadSavedProfileSuccess(null)
      actions.loadSource(imagePath)
      actions.loadSavedProfile(imagePath)
    },
    closeEditor: () => {
      values.source?.bitmap.close()
      actions.loadSourceSuccess(null)
    },
    saveProfile: () => {
      const imagePath = values.imagePath
      if (!imagePath) {
        return
      }
      // The sidecar rides the ordinary upload: the same verb on every
      // control plane, the same toast, the listing updated the same way.
      const sidecar = sidecarPathFor(imagePath)
      const name = sidecar.split('/').pop() || sidecar
      const folder = sidecar.includes('/') ? sidecar.slice(0, sidecar.lastIndexOf('/')) : ''
      const file = new File([serializeAssetColorProfile(values.profile)], name, { type: 'application/json' })
      actions.uploadDroppedFiles(folder, [file])
      actions.loadSavedProfileSuccess(values.profile)
    },
    removeProfile: () => {
      const imagePath = values.imagePath
      if (!imagePath) {
        return
      }
      if (values.hasSavedProfile) {
        actions.deleteAsset(sidecarPathFor(imagePath))
      }
      actions.resetProfile()
      actions.loadSavedProfileSuccess(null)
    },
  })),
])
