import { Field } from '../../../../../components/Field'
import { NumberTextInput } from '../../../../../components/NumberTextInput'
import { Select } from '../../../../../components/Select'
import { Switch } from '../../../../../components/Switch'
import type { FrameDither } from '../../../../../types'
import { useFrameSettings } from '../frameSettingsContext'
import { SectionBody, SectionHeading } from '../sections/FrameSettingsSection'

// How the control plane dithers the picture it packs for this frame's palette
// panel (docs/dithering.md): Floyd-Steinberg by default, or OpenDisplay
// epaper-dithering. The plane's own setting (backend: the frame's `dither`;
// cloud: POST /api/frames/{id}/dither), never sent to the device: it applies
// when the plane packs the picture, i.e. the frame renders its scenes on the
// server or is a thin client.

const ALGORITHMS: { value: string; label: string }[] = [
  { value: 'burkes', label: 'Burkes (default)' },
  { value: 'floyd_steinberg', label: 'Floyd–Steinberg' },
  { value: 'atkinson', label: 'Atkinson (higher contrast)' },
  { value: 'stucki', label: 'Stucki' },
  { value: 'sierra', label: 'Sierra' },
  { value: 'sierra_lite', label: 'Sierra Lite' },
  { value: 'jarvis_judice_ninke', label: 'Jarvis–Judice–Ninke' },
  { value: 'ordered', label: 'Ordered (Bayer)' },
]

/** What the editor shows for a stored value: the defaults panel_dither.py fills in. */
export function ditherFormValue(value: FrameDither | null | undefined): Required<FrameDither> | null {
  if (!value || value.method !== 'opendisplay') {
    return null
  }
  return {
    method: 'opendisplay',
    algorithm: value.algorithm ?? 'burkes',
    dbs: value.dbs ?? false,
    exposure: value.exposure ?? 1,
    viewingDistanceCm: value.viewingDistanceCm ?? 50,
  }
}

function DitherEditor({
  value,
  onChange,
}: {
  value: FrameDither | null | undefined
  onChange: (value: FrameDither | null) => void
}): JSX.Element {
  const current = ditherFormValue(value)
  return (
    <div className="space-y-3 w-full">
      <div className="flex flex-wrap items-center gap-2">
        <span>Method</span>
        <Select
          name="dither.method"
          value={current ? 'opendisplay' : 'floydSteinberg'}
          onChange={(method) => onChange(method === 'opendisplay' ? ditherFormValue({ method: 'opendisplay' }) : null)}
          options={[
            { value: 'floydSteinberg', label: 'Floyd–Steinberg (default)' },
            { value: 'opendisplay', label: 'OpenDisplay (perceptual, measured palettes)' },
          ]}
        />
      </div>
      {current ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span>Algorithm</span>
            <Select
              name="dither.algorithm"
              value={current.algorithm}
              onChange={(algorithm) => onChange({ ...current, algorithm })}
              options={ALGORITHMS}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span>Brightness</span>
            <NumberTextInput
              name="dither.exposure"
              className="!w-24"
              value={Math.round((current.exposure - 1) * 100)}
              onChange={(percent) =>
                onChange({ ...current, exposure: Math.min(2, Math.max(0.5, 1 + (percent ?? 0) / 100)) })
              }
            />
            <span className="frameos-muted text-sm">% (−50 to +100; brighter suits most measured palettes)</span>
          </div>
          <Switch
            label="Refine for viewing distance (DBS)"
            value={current.dbs}
            onChange={(dbs) => onChange({ ...current, dbs })}
          />
          {current.dbs ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>Viewing distance</span>
              <NumberTextInput
                name="dither.viewingDistanceCm"
                className="!w-24"
                value={current.viewingDistanceCm}
                onChange={(distance) =>
                  onChange({ ...current, viewingDistanceCm: Math.min(500, Math.max(10, distance ?? 50)) })
                }
              />
              <span className="frameos-muted text-sm">cm</span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export function DitheringSection(): JSX.Element {
  const { palette } = useFrameSettings()
  return (
    <>
      <SectionHeading id="frame-settings-dithering">Dithering</SectionHeading>
      <SectionBody className="space-y-2">
        {palette ? (
          <>
            <p className="frameos-muted text-sm">
              How the picture is dithered to the panel's colors when FrameOS renders this frame's scenes on the server
              (or the frame is a thin client). A frame that renders its own scenes keeps Floyd–Steinberg. OpenDisplay
              matches colors as the eye sees them and works best with the panel's measured palette above.
            </p>
            <Field name="dither" label="">
              {({ value, onChange }: { value: FrameDither | null; onChange: (v: FrameDither | null) => void }) => (
                <DitherEditor value={value} onChange={onChange} />
              )}
            </Field>
          </>
        ) : (
          <p className="frameos-muted text-sm">This panel has no color palette to dither to.</p>
        )}
      </SectionBody>
    </>
  )
}
