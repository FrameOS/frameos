import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { useEffect, useRef } from 'react'
import { Button } from '../../../../components/Button'
import { ColorInput } from '../../../../components/ColorInput'
import { Modal } from '../../../../components/Modal'
import { Select } from '../../../../components/Select'
import { Spinner } from '../../../../components/Spinner'
import { Switch } from '../../../../components/Switch'
import { spectraPalettes } from '../../../../devices'
import { visiblePalette } from '../../../../utils/assetColors/devicePalette'
import {
  HUE_RANGE_NAMES,
  TONE_RANGE_NAMES,
  hexToTriplet,
  tripletToHex,
  type HueRangeName,
  type ToneRangeName,
} from '../../../../utils/assetColors/profile'
import type { FrameId } from '../../../../types'
import { type AdjustmentMode, assetColorsLogic, renderColorPreview } from './assetColorsLogic'

const hueSwatches: Record<HueRangeName, string> = {
  red: '#e03131',
  orange: '#f08c00',
  yellow: '#f5d90a',
  green: '#2f9e44',
  aqua: '#15aabf',
  blue: '#1c7ed6',
  purple: '#7048e8',
  magenta: '#d6336c',
}

const toneLabels: Record<ToneRangeName, string> = {
  shadows: 'Shadows',
  midtones: 'Midtones',
  highlights: 'Highlights',
}

function Slider({
  label,
  value,
  onChange,
  min = -100,
  max = 100,
  step = 1,
  hint,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  hint?: string
}): JSX.Element {
  const display = step < 1 ? value.toFixed(2).replace(/\.?0+$/, '') : String(value)
  return (
    <label className="block" title={hint}>
      <span className="flex items-center justify-between text-xs">
        <span className="frame-tool-muted">{label}</span>
        <span className={clsx('tabular-nums', value !== 0 ? 'font-semibold' : 'frame-tool-muted')}>{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onDoubleClick={() => onChange(0)}
        aria-label={label}
        className="mt-0.5 w-full accent-blue-500"
      />
    </label>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="frame-tool-card rounded-2xl p-3">
      <div className="frame-tool-muted mb-2 text-xs font-semibold uppercase tracking-wide">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

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
    selectedTone,
    selectedHue,
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
    setSlider,
    setTone,
    setHue,
    setAdjustmentMode,
    setPalette,
    setPaletteColor,
    setSelectedTone,
    setSelectedHue,
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
  const tone = profile[selectedTone]
  const hue = profile.hues[selectedHue]
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
          <Section title="Light">
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
            <Slider
              label="Exposure"
              value={profile.exposure}
              min={-3}
              max={3}
              step={0.05}
              onChange={(value) => setSlider('exposure', value)}
            />
            <Slider label="Contrast" value={profile.contrast} onChange={(value) => setSlider('contrast', value)} />
            <Slider
              label="Whites"
              value={profile.whites}
              onChange={(value) => setSlider('whites', value)}
              hint="Negative keeps detail in the highlights"
            />
            <Slider label="Blacks" value={profile.blacks} onChange={(value) => setSlider('blacks', value)} />
            <Slider
              label="Saturation"
              value={profile.saturation}
              onChange={(value) => setSlider('saturation', value)}
            />
          </Section>

          <Section title="Tones">
            <div className="flex gap-1">
              {TONE_RANGE_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setSelectedTone(name)}
                  className={clsx(
                    'flex-1 rounded-lg border px-2 py-1 text-xs transition',
                    selectedTone === name
                      ? 'frameos-primary-outline-action font-semibold'
                      : 'frame-tool-muted border-transparent hover:underline'
                  )}
                >
                  {toneLabels[name]}
                </button>
              ))}
            </div>
            <Slider
              label="Brightness"
              value={tone.luminance}
              onChange={(value) => setTone(selectedTone, 'luminance', value)}
            />
            <Slider label="Red" value={tone.r} onChange={(value) => setTone(selectedTone, 'r', value)} />
            <Slider label="Green" value={tone.g} onChange={(value) => setTone(selectedTone, 'g', value)} />
            <Slider label="Blue" value={tone.b} onChange={(value) => setTone(selectedTone, 'b', value)} />
          </Section>

          <Section title="Colors">
            <div className="flex flex-wrap gap-1.5">
              {HUE_RANGE_NAMES.map((name) => {
                const range = profile.hues[name]
                const touched = range.hue !== 0 || range.saturation !== 0 || range.luminance !== 0
                return (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    aria-label={name}
                    onClick={() => setSelectedHue(name)}
                    className={clsx(
                      'h-6 w-6 rounded-full border-2 transition',
                      selectedHue === name ? 'scale-110 border-white ring-2 ring-blue-400' : 'border-transparent',
                      touched && 'shadow-[0_0_0_2px_rgba(255,255,255,0.6)]'
                    )}
                    style={{ backgroundColor: hueSwatches[name] }}
                  />
                )
              })}
              <span className="frame-tool-muted ml-1 self-center text-xs capitalize">{selectedHue}</span>
            </div>
            <Slider
              label="Hue"
              value={hue.hue}
              min={-180}
              max={180}
              onChange={(value) => setHue(selectedHue, 'hue', value)}
              hint="Degrees around the colour wheel"
            />
            <Slider
              label="Saturation"
              value={hue.saturation}
              onChange={(value) => setHue(selectedHue, 'saturation', value)}
            />
            <Slider
              label="Luminance"
              value={hue.luminance}
              onChange={(value) => setHue(selectedHue, 'luminance', value)}
            />
          </Section>

          <Section title="Dither palette">
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
          </Section>
        </div>
      </div>
    </Modal>
  )
}
