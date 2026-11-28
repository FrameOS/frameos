// How the plane dithers a palette panel's picture (docs/dithering.md): the
// settings the Dithering section offers, its built-in presets, and how a
// stored value is matched back to a preset. The ranges and defaults mirror
// backend/app/utils/panel_dither.py and cloud/apps/auth-web/src/lib/
// panel-dither.ts, which check and clamp what is stored.

import type { DitherPreset, FrameDither } from '../types'

export const DITHER_ALGORITHMS: { value: string; label: string }[] = [
  { value: 'burkes', label: 'Burkes (default)' },
  { value: 'floyd_steinberg', label: 'Floyd–Steinberg' },
  { value: 'atkinson', label: 'Atkinson (higher contrast)' },
  { value: 'stucki', label: 'Stucki' },
  { value: 'sierra', label: 'Sierra' },
  { value: 'sierra_lite', label: 'Sierra Lite' },
  { value: 'jarvis_judice_ninke', label: 'Jarvis–Judice–Ninke' },
  { value: 'ordered', label: 'Ordered (Bayer)' },
]

export const DEFAULT_VIEWING_DISTANCE_CM = 30

/** The tone and colour steps OpenDisplay runs before matching inks, each a no-op at its default. */
export const DITHER_ADJUSTMENTS: {
  key: 'saturation' | 'shadows' | 'highlights' | 'tone' | 'gamut'
  label: string
  hint: string
  min: number
  max: number
  default: number
}[] = [
  {
    key: 'saturation',
    label: 'Saturation',
    hint: '100% leaves colors as they are; lower mutes them, higher makes them stronger.',
    min: 0,
    max: 2,
    default: 1,
  },
  {
    key: 'shadows',
    label: 'Shadows',
    hint: 'Lifts dark areas so detail in them shows.',
    min: 0,
    max: 1,
    default: 0,
  },
  {
    key: 'highlights',
    label: 'Highlights',
    hint: 'Compresses bright areas, so skies and white walls keep some texture.',
    min: 0,
    max: 1,
    default: 0,
  },
  {
    key: 'tone',
    label: 'Tone',
    hint: "Maps the picture's lightness onto the panel's darkest and lightest ink: more shadow detail, lighter blacks.",
    min: 0,
    max: 1,
    default: 0,
  },
  {
    key: 'gamut',
    label: 'Gamut compression',
    hint: 'Pulls colors the panel cannot show towards ones it can, instead of clipping them.',
    min: 0,
    max: 1,
    default: 0,
  },
]

export type NormalizedFrameDither = Required<Omit<FrameDither, 'ppi'>> & { ppi: number | null }

function clamp(value: unknown, low: number, high: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback
}

/** normalize_dither: null for Floyd–Steinberg, else every field filled in (what the packer reads). */
export function normalizeFrameDither(value: FrameDither | null | undefined): NormalizedFrameDither | null {
  if (!value || value.method !== 'opendisplay') {
    return null
  }
  const normalized = {
    method: 'opendisplay',
    algorithm: DITHER_ALGORITHMS.some((option) => option.value === value.algorithm)
      ? (value.algorithm as string)
      : 'burkes',
    dbs: value.dbs === true,
    exposure: clamp(value.exposure, 0.5, 2, 1),
    viewingDistanceCm: clamp(value.viewingDistanceCm, 10, 500, DEFAULT_VIEWING_DISTANCE_CM),
    ppi: value.ppi === null || value.ppi === undefined ? null : clamp(value.ppi, 50, 600, 127),
  } as NormalizedFrameDither
  for (const adjustment of DITHER_ADJUSTMENTS) {
    normalized[adjustment.key] = clamp(value[adjustment.key], adjustment.min, adjustment.max, adjustment.default)
  }
  return normalized
}

/** The built-in presets. Only settings tried on real panels are offered. */
export const BUILTIN_DITHER_PRESETS: { id: string; name: string; description: string; dither: FrameDither | null }[] = [
  {
    id: 'builtin:floydSteinberg',
    name: 'Floyd–Steinberg (FrameOS default)',
    description: 'What the frame does itself: fast, matches colors by their numbers.',
    dither: null,
  },
  {
    id: 'builtin:opendisplay',
    name: 'OpenDisplay',
    description: 'Matches colors as the eye sees them; no tone changes.',
    dither: { method: 'opendisplay' },
  },
  {
    id: 'builtin:opendisplayPhoto',
    name: 'OpenDisplay photo',
    description:
      'Brighter (+30%) and refined for a 30 cm viewing distance: picked as best on 4" and 7.3" Spectra 6 panels with a measured palette.',
    dither: { method: 'opendisplay', exposure: 1.3, dbs: true, viewingDistanceCm: 30 },
  },
]

/** Whether two stored values dither the same (what the packer reads, not how it was written). */
export function sameDither(a: FrameDither | null | undefined, b: FrameDither | null | undefined): boolean {
  return JSON.stringify(normalizeFrameDither(a)) === JSON.stringify(normalizeFrameDither(b))
}

/** The preset (built-in first, then the owner's) a stored value is, or null for custom settings. */
export function matchingPresetId(value: FrameDither | null | undefined, own: DitherPreset[]): string | null {
  const builtin = BUILTIN_DITHER_PRESETS.find((preset) => sameDither(preset.dither, value))
  if (builtin) {
    return builtin.id
  }
  return own.find((preset) => sameDither(preset.dither, value))?.id ?? null
}

/** How many settings differ from plain OpenDisplay (for the "n changed" note). */
export function changedSettingsCount(value: FrameDither | null | undefined): number {
  const current = normalizeFrameDither(value)
  const plain = normalizeFrameDither({ method: 'opendisplay' })
  if (!current || !plain) {
    return 0
  }
  // The viewing distance only counts while DBS, which reads it, is on.
  return (Object.keys(plain) as (keyof NormalizedFrameDither)[]).filter(
    (key) => current[key] !== plain[key] && !(key === 'viewingDistanceCm' && !current.dbs)
  ).length
}

/** A stored value with only what differs from the defaults: what a preset saves. */
export function compactDither(value: FrameDither | null | undefined): FrameDither | null {
  const current = normalizeFrameDither(value)
  const plain = normalizeFrameDither({ method: 'opendisplay' })
  if (!current || !plain) {
    return null
  }
  const compact: FrameDither = { method: 'opendisplay' }
  for (const key of Object.keys(current) as (keyof NormalizedFrameDither)[]) {
    if (key !== 'method' && current[key] !== plain[key]) {
      ;(compact as unknown as Record<string, unknown>)[key] = current[key]
    }
  }
  return compact
}

export function newDitherPresetId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
