import { useActions, useValues } from 'kea'
import { useEffect, useRef } from 'react'
import { Button } from '../../../../components/Button'
import { ColorInput } from '../../../../components/ColorInput'
import { Modal } from '../../../../components/Modal'
import { Select } from '../../../../components/Select'
import { Spinner } from '../../../../components/Spinner'
import { Switch } from '../../../../components/Switch'
import { spectraPalettes } from '../../../../devices'
import { visiblePalette } from '../../../../utils/assetColors/devicePalette'
import { hexToTriplet, tripletToHex } from '../../../../utils/assetColors/profile'
import { ColorAdjustmentControls, ColorSection } from './ColorAdjustmentControls'
import type { FrameId } from '../../../../types'
import { type AdjustmentMode, assetColorsLogic, renderColorPreview } from './assetColorsLogic'

/** The panel-sized preview, repainted whenever a slider moves. */
function Preview({ frameId }: { frameId: FrameId }): JSX.Element {
  const { source, sourceLoading, sourceError, profile, panelPalette, imageSize, showDithered, showAdjusted, fit } =
    useValues(assetColorsLogic({ frameId }))
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
      })
      if (!imageData) {
        return
      }
      canvas.width = imageSize.width
      canvas.height = imageSize.height
      canvas.getContext('2d')?.putImageData(imageData, 0, 0)
    })
    return () => window.cancelAnimationFrame(handle)
  }, [source, profile, panelPalette, imageSize.width, imageSize.height, showDithered, showAdjusted, fit])

  return (
    <div className="frame-tool-card flex min-h-[16rem] items-center justify-center overflow-hidden rounded-2xl bg-slate-900/80 p-2">
      {sourceError ? (
        <div className="p-6 text-sm text-red-400">{sourceError}</div>
      ) : sourceLoading || !source ? (
        <Spinner className="h-8 w-8" color="white" />
      ) : (
        <canvas
          ref={canvasRef}
          className="max-h-[calc(100dvh-20rem)] max-w-full object-contain"
          style={{ imageRendering: showDithered ? 'pixelated' : 'auto' }}
        />
      )}
    </div>
  )
}

export function AssetColorsModal({ frameId }: { frameId: FrameId }): JSX.Element | null {
  const logic = assetColorsLogic({ frameId })
  const {
    imagePath,
    profile,
    panelPalette,
    showDithered,
    showAdjusted,
    fit,
    canSave,
    isDefault,
    hasSavedProfile,
    savedProfileLoading,
    adjustmentMode,
    autoEndPoints,
  } = useValues(logic)
  const {
    closeEditor,
    setProfile,
    setAdjustmentMode,
    setPalette,
    setPaletteColor,
    setShowDithered,
    setShowAdjusted,
    setFit,
    resetProfile,
    saveProfile,
    removeProfile,
  } = useActions(logic)

  if (!imagePath) {
    return null
  }

  const fileName = imagePath.split('/').pop() || imagePath
  const panelColors = visiblePalette(panelPalette)
  const customPalette = profile.palette
  const paletteColors = customPalette ?? panelColors
  const presets = panelColors.length === 6 ? spectraPalettes : []

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
      footer={
        <div className="frameos-divider flex flex-wrap items-center gap-2 border-t p-4">
          <Button color="secondary" size="small" onClick={resetProfile} disabled={isDefault}>
            Reset sliders
          </Button>
          {hasSavedProfile ? (
            <Button color="red" size="small" onClick={removeProfile}>
              Remove colors
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button color="secondary" size="small" onClick={closeEditor}>
              Cancel
            </Button>
            <Button color="primary" size="small" onClick={saveProfile} disabled={!canSave}>
              {savedProfileLoading ? 'Loading' : 'Save'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-4 p-4 @container lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-3">
          <Preview frameId={frameId} />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Switch
              value={showDithered}
              onChange={setShowDithered}
              label={panelColors.length > 0 ? 'Dithered as on the panel' : 'Dithered (no palette for this display)'}
              disabled={panelColors.length === 0 && !customPalette}
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
          <p className="frame-tool-muted text-xs">
            The panel's white is darker than a photo's. Pull Whites down, or switch on Auto, to keep texture in bright
            areas instead of flat white. Saved next to the photo as {fileName}.frameos.json.
          </p>
        </div>

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
                <span className="frame-tool-muted text-xs">This display shows full colour; nothing to dither to.</span>
              ) : null}
            </div>
          </ColorSection>
        </div>
      </div>
    </Modal>
  )
}
