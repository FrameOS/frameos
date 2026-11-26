import { useActions, useValues } from 'kea'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../../../components/Button'
import { Field } from '../../../../../components/Field'
import { NumberTextInput } from '../../../../../components/NumberTextInput'
import { Select } from '../../../../../components/Select'
import { Spinner } from '../../../../../components/Spinner'
import { Switch } from '../../../../../components/Switch'
import { TextInput } from '../../../../../components/TextInput'
import { Tooltip } from '../../../../../components/Tooltip'
import type { DitherPreset, FrameDither, FrameType } from '../../../../../types'
import { frameAssetsApiPath } from '../../../../../utils/frameAssetsApi'
import { getBasePath } from '../../../../../utils/getBasePath'
import {
  paletteDeviceOf,
  panelPaletteForFrame,
  panelPaletteKindForFrame,
  visiblePalette,
} from '../../../../../utils/assetColors/devicePalette'
import { ditherToPalette } from '../../../../../utils/assetColors/dither'
import {
  BUILTIN_DITHER_PRESETS,
  DITHER_ADJUSTMENTS,
  DITHER_ALGORITHMS,
  changedSettingsCount,
  compactDither,
  matchingPresetId,
  newDitherPresetId,
  normalizeFrameDither,
  type NormalizedFrameDither,
} from '../../../../../utils/ditherPresets'
import { deviceLabelFor } from '../../Assets/assetColorsLogic'
import { settingsLogic } from '../../../../settings/settingsLogic'
import { useFrameSettings } from '../frameSettingsContext'
import { SectionBody, SectionHeading } from '../sections/FrameSettingsSection'

// How the control plane dithers the picture it packs for this frame's palette
// panel (docs/dithering.md). Like Colors: a preset, and fine tuning that
// previews the frame's current image and saves the owner's own presets
// (`ditherPresets` in the settings). The plane's own setting (backend: the
// frame's `dither`; cloud: POST /api/frames/{id}/dither), never sent to the
// device: it applies when the plane packs the picture, i.e. the frame renders
// its scenes on the server or is a thin client.

const CUSTOM = 'custom'

/** The inks of a palette kind's visible colours, in order: OpenDisplay names each one. */
const INKS: Partial<Record<string, string[]>> = {
  spectra6: ['black', 'white', 'yellow', 'red', 'blue', 'green'],
  sevenColor: ['black', 'white', 'green', 'blue', 'red', 'yellow', 'orange'],
  fourColor: ['black', 'white', 'yellow', 'red'],
}
const NOMINAL: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  yellow: '#ffff00',
  red: '#ff0000',
  blue: '#0000ff',
  green: '#00ff00',
  orange: '#ff8000',
}

/** panel_ppi: the density the plane uses, from the panel's name (`EPD_7in3e` = 7.3"). */
function panelPpiOf(frame: Partial<FrameType>, width: number, height: number): number {
  const hardwarePanel = (frame.hardware as { panel?: unknown } | null | undefined)?.panel
  const name = (typeof hardwarePanel === 'string' ? hardwarePanel : frame.device) ?? ''
  const short = name.split('.').pop() ?? name
  const inches = /(\d+)in(\d)/.exec(short)
  const impression = /impression_(\d+(?:\.\d+)?)/.exec(short)
  const diagonal = inches ? Number(`${inches[1]}.${inches[2]}`) : impression ? Number(impression[1]) : null
  return diagonal && width > 0 && height > 0 ? Math.hypot(width, height) / diagonal : 127
}

type OpenDisplay = typeof import('@opendisplay/epaper-dithering')
let openDisplayModule: Promise<OpenDisplay> | null = null
function loadOpenDisplay(): Promise<OpenDisplay> {
  // Only fine tuning needs it: the WASM build stays out of the main bundle.
  openDisplayModule ??= import('@opendisplay/epaper-dithering')
  return openDisplayModule
}

/**
 * The frame's current image dithered with `dither` (null: Floyd–Steinberg),
 * painted in the panel's colours. OpenDisplay runs the same Rust core as both
 * planes' packers, so this is the picture the frame will get.
 */
function DitherPreview({
  frame,
  dither,
}: {
  frame: Partial<FrameType> & Pick<FrameType, 'id'>
  dither: NormalizedFrameDither | null
}): JSX.Element {
  const [source, setSource] = useState<ImageBitmap | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [took, setTook] = useState<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const panel = {
    device: frame.device,
    palette: frame.palette,
    device_config: frame.device_config,
    embedded: frame.embedded,
    hardware: frame.hardware,
  }
  const deviceLabel = deviceLabelFor(paletteDeviceOf(panel))
  const palette = visiblePalette(panelPaletteForFrame(panel, deviceLabel))
  const inks = INKS[panelPaletteKindForFrame(panel, deviceLabel)]
  const key = JSON.stringify([dither, palette])

  useEffect(() => {
    let cancelled = false
    fetch(`${getBasePath()}${frameAssetsApiPath(frame.id, 'image')}?t=-1`, { credentials: 'include' })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => (cancelled ? bitmap.close() : setSource(bitmap)))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [frame.id])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !source || palette.length === 0) {
      return
    }
    let cancelled = false
    // DBS takes a moment on a big panel: wait for the sliders to settle.
    const timer = window.setTimeout(async () => {
      setBusy(true)
      const started = performance.now()
      canvas.width = source.width
      canvas.height = source.height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) {
        return
      }
      context.drawImage(source, 0, 0)
      const imageData = context.getImageData(0, 0, source.width, source.height)
      if (dither && inks && inks.length === palette.length) {
        try {
          const od = await loadOpenDisplay()
          const odPalette = od.Palette.fromSrgb(
            palette.map(([r, g, b], index) => ({ rgb: { r, g, b }, name: inks[index], nominal: NOMINAL[inks[index]] })),
            true
          )
          const result = od.ditherImage(
            { width: source.width, height: source.height, data: imageData.data },
            odPalette,
            {
              mode: dither.algorithm as never,
              exposure: dither.exposure,
              saturation: dither.saturation,
              shadows: dither.shadows,
              highlights: dither.highlights,
              tone: dither.tone,
              gamut: dither.gamut,
              dbs: dither.dbs
                ? {
                    viewingDistanceCm: dither.viewingDistanceCm,
                    ppi: dither.ppi ?? panelPpiOf(frame, source.width, source.height),
                  }
                : false,
            }
          )
          for (let i = 0; i < result.indices.length; i += 1) {
            const [r, g, b] = palette[result.indices[i]]
            imageData.data[i * 4] = r
            imageData.data[i * 4 + 1] = g
            imageData.data[i * 4 + 2] = b
          }
        } catch {
          ditherToPalette(imageData.data, source.width, source.height, palette)
        }
      } else {
        ditherToPalette(imageData.data, source.width, source.height, palette)
      }
      if (!cancelled) {
        context.putImageData(imageData, 0, 0)
        setTook(Math.round(performance.now() - started))
        setBusy(false)
      }
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [source, key])

  return (
    <div className="space-y-1">
      <div className="frame-tool-card relative flex min-h-[8rem] items-center justify-center overflow-hidden rounded-2xl bg-slate-900/80 p-2">
        {failed ? (
          <span className="frame-tool-muted p-4 text-xs">No current image to preview on.</span>
        ) : source ? (
          <canvas ref={canvasRef} className="max-h-[22rem] max-w-full object-contain" />
        ) : (
          <Spinner className="h-6 w-6" color="white" />
        )}
        {busy && source ? <Spinner className="absolute right-3 top-3 h-4 w-4" color="white" /> : null}
      </div>
      <p className="frameos-muted text-xs">
        The frame&apos;s current image, dithered as the panel will show it and painted in its palette&apos;s colors
        {took !== null ? ` (${took} ms here)` : ''}. Zoom in to judge the dots; step back to judge the picture.
      </p>
    </div>
  )
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="flex w-36 shrink-0 items-center gap-1">
        {label}
        <Tooltip title={hint} />
      </span>
      <input
        type="range"
        className="min-w-0 flex-1"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-12 text-right tabular-nums">{format(value)}</span>
    </label>
  )
}

const percent = (value: number): string => `${Math.round(value * 100)}%`
const signedPercent = (value: number): string => `${value >= 1 ? '+' : '−'}${Math.abs(Math.round((value - 1) * 100))}%`

/** Every OpenDisplay setting, for the fine tuning panel. */
function DitherControls({
  current,
  frame,
  onChange,
}: {
  current: NormalizedFrameDither
  frame: Partial<FrameType>
  onChange: (value: FrameDither) => void
}): JSX.Element {
  const set = (patch: Partial<NormalizedFrameDither>): void => onChange({ ...current, ...patch })
  const width = Number(frame.width) || 0
  const height = Number(frame.height) || 0
  const fromName = Math.round(panelPpiOf(frame, width, height))
  return (
    <div className="space-y-3">
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-36 shrink-0">Algorithm</span>
        <Select
          name="dither.algorithm"
          value={current.algorithm}
          onChange={(algorithm) => set({ algorithm })}
          options={DITHER_ALGORITHMS}
          className="min-w-0 flex-1"
        />
      </label>
      <Slider
        label="Brightness"
        hint="Linear-light exposure before dithering. Spectra panels are darker than a screen; +30% suits most measured palettes."
        value={current.exposure}
        min={0.5}
        max={2}
        step={0.05}
        format={signedPercent}
        onChange={(exposure) => set({ exposure })}
      />
      {DITHER_ADJUSTMENTS.map((adjustment) => (
        <Slider
          key={adjustment.key}
          label={adjustment.label}
          hint={adjustment.hint}
          value={current[adjustment.key]}
          min={adjustment.min}
          max={adjustment.max}
          step={0.05}
          format={adjustment.key === 'saturation' ? percent : (value) => (value === 0 ? 'off' : percent(value))}
          onChange={(value) => set({ [adjustment.key]: value })}
        />
      ))}
      <Switch label="Refine for viewing distance (DBS)" value={current.dbs} onChange={(dbs) => set({ dbs })} />
      {current.dbs ? (
        <>
          <Slider
            label="Viewing distance"
            hint='How far away the frame is looked at. DBS arranges the dots to look right from there; 30 cm suited 4" and 7.3" panels best (50 cm drew colored outlines at dark edges).'
            value={current.viewingDistanceCm}
            min={10}
            max={200}
            step={5}
            format={(value) => `${value} cm`}
            onChange={(viewingDistanceCm) => set({ viewingDistanceCm })}
          />
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex w-36 shrink-0 items-center gap-1">
              Panel density
              <Tooltip title="Pixels per inch, which DBS needs with the viewing distance. Read from the panel's name; set it here when the name does not say the panel's size." />
            </span>
            <NumberTextInput
              name="dither.ppi"
              className="!w-24"
              value={current.ppi ?? undefined}
              placeholder={String(fromName)}
              onChange={(ppi) =>
                set({ ppi: ppi === undefined || ppi === null ? null : Math.min(600, Math.max(50, ppi)) })
              }
            />
            <span className="frameos-muted text-xs">
              ppi {current.ppi === null ? `(${fromName} from the panel's name)` : ''}
            </span>
          </label>
        </>
      ) : null}
    </div>
  )
}

export function DitheringSection(): JSX.Element {
  const { frame, frameForm, palette } = useFrameSettings()
  const { savedSettings } = useValues(settingsLogic)
  const { saveDitherPresets } = useActions(settingsLogic)
  const ownPresets: DitherPreset[] = savedSettings.ditherPresets ?? []
  const [showFineTuning, setShowFineTuning] = useState(false)
  const [newName, setNewName] = useState('')
  return (
    <>
      <SectionHeading id="frame-settings-dithering">Dithering</SectionHeading>
      <SectionBody className="space-y-3">
        {!palette ? (
          <p className="frameos-muted text-sm">This panel has no color palette to dither to.</p>
        ) : (
          <Field name="dither" label="">
            {({ value, onChange }: { value: FrameDither | null; onChange: (v: FrameDither | null) => void }) => {
              const current = normalizeFrameDither(value)
              const presetId = matchingPresetId(value, ownPresets) ?? CUSTOM
              const builtin = BUILTIN_DITHER_PRESETS.find((preset) => preset.id === presetId)
              const own = ownPresets.find((preset) => preset.id === presetId)
              const changed = changedSettingsCount(value)
              const saveAs = (): void => {
                const dither = compactDither(value)
                if (!dither || !newName.trim()) {
                  return
                }
                saveDitherPresets([
                  ...ownPresets,
                  { id: newDitherPresetId(), name: newName.trim().slice(0, 60), dither },
                ])
                setNewName('')
              }
              return (
                <div className="w-full space-y-3">
                  <p className="frameos-muted text-sm">
                    How the picture is dithered to the panel&apos;s colors when FrameOS renders this frame&apos;s scenes
                    on the server (or the frame is a thin client). A frame that renders its own scenes keeps
                    Floyd–Steinberg. OpenDisplay matches colors as the eye sees them and works best with the
                    panel&apos;s measured palette above.
                  </p>
                  <label className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="@md:w-1/3">Preset</span>
                    <Select
                      name="dither.preset"
                      value={presetId}
                      onChange={(id) => {
                        const chosen =
                          BUILTIN_DITHER_PRESETS.find((preset) => preset.id === id) ??
                          ownPresets.find((preset) => preset.id === id)
                        if (chosen) {
                          onChange(chosen.dither ? { ...chosen.dither } : null)
                        }
                      }}
                      options={[
                        ...BUILTIN_DITHER_PRESETS.map((preset) => ({ value: preset.id, label: preset.name })),
                        ...ownPresets.map((preset) => ({ value: preset.id, label: `${preset.name} (yours)` })),
                        ...(presetId === CUSTOM ? [{ value: CUSTOM, label: 'Custom settings' }] : []),
                      ]}
                      className="min-w-0 flex-1"
                    />
                  </label>
                  {builtin ? <p className="frameos-muted text-xs">{builtin.description}</p> : null}
                  {current ? (
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="flex items-center gap-1">
                        Fine tuning
                        <Tooltip title="Every OpenDisplay setting, previewed on the frame's current image dithered as the panel will show it. Save what you like as your own preset, to use it on other frames too." />
                        <span className="frameos-muted text-xs">
                          ({changed === 0 ? 'nothing changed' : `${changed} setting${changed === 1 ? '' : 's'} changed`}
                          )
                        </span>
                      </span>
                      <Button size="small" color="secondary" onClick={() => setShowFineTuning(!showFineTuning)}>
                        {showFineTuning ? 'Hide fine tuning' : 'Show fine tuning'}
                      </Button>
                    </div>
                  ) : (
                    <p className="frameos-muted text-xs">Pick an OpenDisplay preset to fine tune it.</p>
                  )}
                  {current && showFineTuning ? (
                    <div className="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_22rem]">
                      <DitherPreview
                        frame={{ ...frame, ...frameForm, id: frame.id } as Partial<FrameType> & Pick<FrameType, 'id'>}
                        dither={current}
                      />
                      <div className="space-y-3">
                        <DitherControls
                          current={current}
                          frame={{ ...frame, ...frameForm }}
                          onChange={(next) => onChange(next)}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <TextInput
                            name="dither.presetName"
                            className="min-w-0 flex-1"
                            placeholder="Name for a new preset"
                            value={newName}
                            onChange={setNewName}
                          />
                          <Button size="small" color="secondary" disabled={!newName.trim()} onClick={saveAs}>
                            Save as preset
                          </Button>
                        </div>
                        {own ? (
                          <Button
                            size="small"
                            color="secondary"
                            onClick={() => saveDitherPresets(ownPresets.filter((preset) => preset.id !== own.id))}
                          >
                            Delete preset “{own.name}”
                          </Button>
                        ) : null}
                        <p className="frameos-muted text-xs">
                          Presets are kept with your settings and offered on every frame. The frame keeps the values
                          themselves: changing or deleting a preset later does not change it.
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            }}
          </Field>
        )}
      </SectionBody>
    </>
  )
}
