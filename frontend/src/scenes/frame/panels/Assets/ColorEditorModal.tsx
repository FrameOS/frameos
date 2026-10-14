import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import clsx from 'clsx'
import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react'
import { Button } from '../../../../components/Button'
import { ColorInput } from '../../../../components/ColorInput'
import { Modal } from '../../../../components/Modal'
import { Select } from '../../../../components/Select'
import { Spinner } from '../../../../components/Spinner'
import { Switch } from '../../../../components/Switch'
import { spectraPalettes } from '../../../../devices'
import type { AutoEndPoints } from '../../../../utils/assetColors/adjust'
import { visiblePalette } from '../../../../utils/assetColors/devicePalette'
import {
  type AssetColorProfile,
  type RgbTriplet,
  hexToTriplet,
  tripletToHex,
} from '../../../../utils/assetColors/profile'
import { ColorAdjustmentControls, ColorSection } from './ColorAdjustmentControls'
import {
  type AdjustmentMode,
  type PreviewFit,
  type PreviewSource,
  renderColorPreview,
} from '../../../../utils/assetColors/preview'

/**
 * What the "Set colors" editor reads. A frame asset (assetColorsLogic) and a
 * Photos library photo (photoColorsLogic) each have a logic with these
 * values and actions; the editor itself is the same. The Assets panel shows
 * it as a modal (ColorEditorModal); the Photos lightbox shows the same
 * pieces as a side panel next to the photo.
 */
export interface ColorEditorValues {
  imagePath: string | null
  profile: AssetColorProfile
  panelPalette: RgbTriplet[] | null
  showDithered: boolean
  showAdjusted: boolean
  fit: PreviewFit
  canSave: boolean
  isDefault: boolean
  hasSavedProfile: boolean
  savedProfileLoading: boolean
  adjustmentMode: AdjustmentMode
  autoEndPoints: AutoEndPoints | null
  imagePosition: { index: number; count: number }
  previousImagePath: string | null
  nextImagePath: string | null
  source: PreviewSource | null
  sourceLoading: boolean
  sourceError: string | null
  imageSize: { width: number; height: number }
  /** The frame's fine tuning, previewed after the photo's own adjustments. */
  globalProfile?: AssetColorProfile | null
}

export interface ColorEditorActions {
  closeEditor: () => void
  setProfile: (profile: AssetColorProfile) => void
  setAdjustmentMode: (mode: AdjustmentMode) => void
  setPalette: (palette: RgbTriplet[] | null) => void
  setPaletteColor: (index: number, color: RgbTriplet) => void
  setShowDithered: (showDithered: boolean) => void
  setShowAdjusted: (showAdjusted: boolean) => void
  setFit: (fit: PreviewFit) => void
  resetProfile: () => void
  saveProfile: () => void
  removeProfile: () => void
  openPreviousImage: () => void
  openNextImage: () => void
  saveAndOpenNext: () => void
}

/** The image as the sliders leave it, repainted whenever one moves. */
export function ColorEditorCanvas({
  values,
  className,
  style,
}: {
  values: ColorEditorValues
  className?: string
  style?: CSSProperties
}): JSX.Element {
  const { source, profile, panelPalette, imageSize, showDithered, showAdjusted, fit, globalProfile } = values
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const workRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !source) {
      return
    }
    // One repaint per animation frame: a slider fires far faster than a
    // 1600x1200 dither can run.
    const handle = window.requestAnimationFrame(() => {
      const work = (workRef.current ??= document.createElement('canvas'))
      const imageData = renderColorPreview(work, source, {
        width: imageSize.width,
        height: imageSize.height,
        fit,
        profile,
        panelPalette,
        dithered: showDithered,
        adjusted: showAdjusted,
        globalProfile: showAdjusted ? globalProfile : null,
      })
      if (!imageData) {
        return
      }
      canvas.width = imageSize.width
      canvas.height = imageSize.height
      canvas.getContext('2d')?.putImageData(imageData, 0, 0)
    })
    return () => window.cancelAnimationFrame(handle)
  }, [source, profile, panelPalette, imageSize.width, imageSize.height, showDithered, showAdjusted, fit, globalProfile])

  const dithered = showDithered && visiblePalette(profile.palette ?? panelPalette).length > 0
  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ imageRendering: dithered ? 'pixelated' : 'auto', ...style }}
      onClick={(event) => event.stopPropagation()}
    />
  )
}

/** The panel-sized preview, in the modal's card. */
function Preview({ values }: { values: ColorEditorValues }): JSX.Element {
  const { source, sourceLoading, sourceError } = values
  return (
    <div className="frame-tool-card flex min-h-[16rem] items-center justify-center overflow-hidden rounded-2xl bg-slate-900/80 p-2">
      {sourceError ? (
        <div className="p-6 text-sm text-red-400">{sourceError}</div>
      ) : sourceLoading || !source ? (
        <Spinner className="h-8 w-8" color="white" />
      ) : (
        <ColorEditorCanvas values={values} className="max-h-[calc(100dvh-20rem)] max-w-full object-contain" />
      )}
    </div>
  )
}

/** Dithered, adjusted, and how the photo is placed: what the preview shows. */
export function ColorEditorViewControls({
  values,
  actions,
  children,
  className,
}: {
  values: ColorEditorValues
  actions: ColorEditorActions
  /** Extra controls at the start of the row. */
  children?: ReactNode
  className?: string
}): JSX.Element {
  const { profile, panelPalette, showDithered, showAdjusted, fit } = values
  const { setShowDithered, setShowAdjusted, setFit } = actions
  const panelColors = visiblePalette(panelPalette)
  return (
    <div className={clsx('flex flex-wrap items-center gap-3 text-sm', className)}>
      {children}
      <Switch
        value={showDithered}
        onChange={setShowDithered}
        label={panelColors.length > 0 ? 'Dithered as on the panel' : 'Dithered (no palette for this display)'}
        disabled={panelColors.length === 0 && !profile.palette}
      />
      <Switch value={showAdjusted} onChange={setShowAdjusted} label="Apply adjustments" />
      <span className="ml-auto flex items-center gap-2">
        <span className="frame-tool-muted text-xs">Fit</span>
        <Select
          value={fit}
          onChange={(value) => setFit(value === 'contain' ? 'contain' : 'cover')}
          options={[
            { value: 'cover', label: 'Cover' },
            { value: 'contain', label: 'Contain' },
          ]}
        />
      </span>
    </div>
  )
}

/** The sliders and the dither palette: the editor's right-hand column. */
export function ColorEditorAdjustments({
  values,
  actions,
}: {
  values: ColorEditorValues
  actions: ColorEditorActions
}): JSX.Element {
  const { profile, panelPalette, adjustmentMode, autoEndPoints } = values
  const { setProfile, setAdjustmentMode, setPalette, setPaletteColor } = actions
  const panelColors = visiblePalette(panelPalette)
  const customPalette = profile.palette
  const paletteColors = customPalette ?? panelColors
  const presets = panelColors.length === 6 ? spectraPalettes : []
  return (
    <div className="space-y-3">
      <ColorAdjustmentControls
        profile={profile}
        onChange={setProfile}
        lightHeader={
          <label className="flex items-center gap-2 text-xs">
            <span className="frame-tool-muted shrink-0">Adjustments</span>
            <Select
              value={adjustmentMode}
              onChange={(value) => setAdjustmentMode(value as AdjustmentMode)}
              options={[
                { value: 'none', label: 'None' },
                {
                  value: 'auto',
                  label: autoEndPoints ? 'Auto: fit the photo into the panel range' : 'Auto (nothing to fit)',
                  disabled: !autoEndPoints,
                },
                { value: 'custom', label: 'Custom' },
              ]}
              className="min-w-0 flex-1"
            />
          </label>
        }
      />

      <ColorSection title="Dither palette">
        <Switch
          value={!!customPalette}
          onChange={(value) => setPalette(value ? paletteColors.map((color) => [...color] as typeof color) : null)}
          label="Custom colors for this photo"
          fullWidth
          disabled={panelColors.length === 0 && !customPalette}
        />
        {presets.length > 0 && customPalette ? (
          <Select
            value=""
            onChange={(name) => {
              const preset = presets.find((candidate) => candidate.name === name)
              if (preset) {
                const colors = preset.colors.map(hexToTriplet)
                if (colors.every((color) => color !== null)) {
                  setPalette(colors as NonNullable<(typeof colors)[number]>[])
                }
              }
            }}
            options={[
              { value: '', label: 'Load a preset' },
              ...presets.map((preset) => ({ value: preset.name || '', label: preset.name || 'Custom' })),
            ]}
          />
        ) : null}
        <div className="flex flex-wrap gap-2">
          {paletteColors.map((color, index) => (
            <span key={index} className="flex items-center gap-1">
              {customPalette ? (
                <ColorInput
                  value={tripletToHex(color)}
                  onChange={(value) => {
                    const triplet = hexToTriplet(value)
                    if (triplet) {
                      setPaletteColor(index, triplet)
                    }
                  }}
                  className="w-20"
                />
              ) : (
                <span
                  className="inline-block h-6 w-6 rounded border border-white/40"
                  style={{ backgroundColor: tripletToHex(color) }}
                  title={tripletToHex(color)}
                />
              )}
            </span>
          ))}
          {paletteColors.length === 0 ? (
            <span className="frame-tool-muted text-xs">This display shows full color; nothing to dither to.</span>
          ) : null}
        </div>
      </ColorSection>
    </div>
  )
}

/** Reset, remove, previous / next, cancel, save. */
export function ColorEditorFooter({
  values,
  actions,
  className,
}: {
  values: ColorEditorValues
  actions: ColorEditorActions
  className?: string
}): JSX.Element {
  const { canSave, isDefault, hasSavedProfile, savedProfileLoading, imagePosition, previousImagePath, nextImagePath } =
    values
  const { closeEditor, resetProfile, saveProfile, removeProfile, openPreviousImage, openNextImage, saveAndOpenNext } =
    actions
  return (
    <div className={clsx('flex flex-wrap items-center gap-2', className)}>
      <Button color="secondary" size="small" onClick={resetProfile} disabled={isDefault}>
        Reset sliders
      </Button>
      {hasSavedProfile ? (
        <Button color="red" size="small" onClick={removeProfile}>
          Remove colors
        </Button>
      ) : null}
      {imagePosition.count > 1 ? (
        <div className="flex items-center gap-1">
          <Button
            color="secondary"
            size="small"
            onClick={openPreviousImage}
            disabled={!previousImagePath}
            title="Previous photo in this folder (unsaved changes are dropped)"
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </Button>
          <span className="frame-tool-muted px-1 text-xs tabular-nums">
            {imagePosition.index + 1} of {imagePosition.count}
          </span>
          <Button
            color="secondary"
            size="small"
            onClick={openNextImage}
            disabled={!nextImagePath}
            title="Next photo in this folder (unsaved changes are dropped)"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button color="secondary" size="small" onClick={closeEditor}>
          Cancel
        </Button>
        <Button color="primary" size="small" onClick={saveProfile} disabled={!canSave}>
          {savedProfileLoading ? 'Loading' : 'Save'}
        </Button>
        {nextImagePath ? (
          <Button color="primary" size="small" onClick={saveAndOpenNext} disabled={!canSave}>
            Save &amp; next
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function ColorEditorModal({
  values,
  actions,
  hint,
  previewControls,
}: {
  values: ColorEditorValues
  actions: ColorEditorActions
  /** Under the preview: what the sliders are for and where they are saved. */
  hint: ReactNode
  /** Extra controls at the start of the row under the preview. */
  previewControls?: ReactNode
}): JSX.Element | null {
  const { imagePath } = values
  const { closeEditor } = actions

  if (!imagePath) {
    return null
  }

  const fileName = imagePath.split('/').pop() || imagePath

  return (
    <Modal
      title={
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-2xl">Set colors</span>
          <span className="frame-tool-muted truncate text-sm font-normal">{fileName}</span>
        </span>
      }
      onClose={closeEditor}
      panelClassName="max-w-[1240px]"
      fullHeight
      footer={<ColorEditorFooter values={values} actions={actions} className="frameos-divider border-t p-4" />}
    >
      <div className="grid gap-4 p-4 @container lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-3">
          <Preview values={values} />
          <ColorEditorViewControls values={values} actions={actions}>
            {previewControls}
          </ColorEditorViewControls>
          <p className="frame-tool-muted text-xs">{hint}</p>
        </div>
        <ColorEditorAdjustments values={values} actions={actions} />
      </div>
    </Modal>
  )
}
