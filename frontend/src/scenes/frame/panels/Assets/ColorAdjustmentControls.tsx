import clsx from 'clsx'
import { useState, type ReactElement, type ReactNode } from 'react'
import {
  HUE_RANGE_NAMES,
  TONE_RANGE_NAMES,
  type AssetColorProfile,
  type HueRangeName,
  type ToneRangeName,
} from '../../../../utils/assetColors/profile'

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

export function Slider({
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
}): ReactElement {
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

export function ColorSection({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="frame-tool-card rounded-2xl p-3">
      <div className="frame-tool-muted mb-2 text-xs font-semibold uppercase tracking-wide">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

/**
 * The Lightroom-style slider set: light, tones, colors. One component for
 * the photo editor (Assets panel) and the frame-wide correction (Settings),
 * so the two never drift apart in what a slider means.
 */
export function ColorAdjustmentControls({
  profile,
  onChange,
  lightHeader,
}: {
  profile: AssetColorProfile
  onChange: (profile: AssetColorProfile) => void
  /** Rendered at the top of the Light section (the editor's adjustments select). */
  lightHeader?: ReactNode
}): ReactElement {
  // Which tone range and hue the sliders below show: view state only.
  const [selectedTone, setSelectedTone] = useState<ToneRangeName>('midtones')
  const [selectedHue, setSelectedHue] = useState<HueRangeName>('red')
  const tone = profile[selectedTone]
  const hue = profile.hues[selectedHue]
  const setSlider = (key: 'exposure' | 'contrast' | 'whites' | 'blacks' | 'saturation', value: number): void =>
    onChange({ ...profile, [key]: value })
  const setTone = (key: 'luminance' | 'r' | 'g' | 'b', value: number): void =>
    onChange({ ...profile, [selectedTone]: { ...tone, [key]: value } })
  const setHue = (key: 'hue' | 'saturation' | 'luminance', value: number): void =>
    onChange({ ...profile, hues: { ...profile.hues, [selectedHue]: { ...hue, [key]: value } } })

  return (
    <>
      <ColorSection title="Light">
        {lightHeader}
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
        <Slider label="Saturation" value={profile.saturation} onChange={(value) => setSlider('saturation', value)} />
      </ColorSection>

      <ColorSection title="Tones">
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
        <Slider label="Brightness" value={tone.luminance} onChange={(value) => setTone('luminance', value)} />
        <Slider label="Red" value={tone.r} onChange={(value) => setTone('r', value)} />
        <Slider label="Green" value={tone.g} onChange={(value) => setTone('g', value)} />
        <Slider label="Blue" value={tone.b} onChange={(value) => setTone('b', value)} />
      </ColorSection>

      <ColorSection title="Colors">
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
          onChange={(value) => setHue('hue', value)}
          hint="Degrees around the color wheel"
        />
        <Slider label="Saturation" value={hue.saturation} onChange={(value) => setHue('saturation', value)} />
        <Slider label="Luminance" value={hue.luminance} onChange={(value) => setHue('luminance', value)} />
      </ColorSection>
    </>
  )
}
