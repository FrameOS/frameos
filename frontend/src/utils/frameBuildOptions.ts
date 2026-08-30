import versions from '../../../versions.json'

export type FrameCompilationMode = 'static' | 'precompiled'
export type FrameCompilationModeOptionValue = '' | FrameCompilationMode

export interface FrameBuildOption<T extends string = string> {
  value: T
  label: string
}

export const frameCompilationModeOptions: FrameBuildOption<FrameCompilationModeOptionValue>[] = [
  { value: '', label: 'Prefer binaries, build from source if needed' },
  { value: 'precompiled', label: `Install precompiled binaries (version ${versions.frameos.split('+')[0]})` },
  { value: 'static', label: 'Build from source - single binary (legacy: needs a build environment)' },
]

/** Same mapping for the select, where an empty value ("prefer binaries") is a real choice. */
export function normalizeFrameCompilationModeOption(value: unknown): FrameCompilationModeOptionValue {
  if (value === undefined || value === null || value === '') {
    return ''
  }
  return normalizeFrameCompilationMode(value)
}

// Frames saved before 2026-08-16 may still hold `shared` or `shared-scenes`,
// which built drivers and/or scenes as separate `.so`s. Both are retired; the
// backend maps them to `static`, which builds the same scenes into the one
// binary, and this keeps the select from rendering a blank for them.
export function normalizeFrameCompilationMode(value: unknown): FrameCompilationMode {
  if (value === 'shared' || value === 'shared-scenes') {
    return 'static'
  }
  return value === 'static' || value === 'precompiled' ? value : 'precompiled'
}

interface FrameLegacySourceBuildSource {
  mode?: string | null
  rpios?: { legacySourceBuild?: boolean } | null
  buildroot?: { legacySourceBuild?: boolean } | null
}

/**
 * The one door to a per-frame Nim build (docs/convergence-todo.md, Stage 4;
 * backend twin `frame_legacy_source_build`). Shut by default: the frame gets
 * the released binary and compiled scenes simply do not run. Open: the
 * installation mode applies and compiled scenes force a source build.
 */
export function frameLegacySourceBuild(frame?: FrameLegacySourceBuildSource | null): boolean {
  const settings = frame?.mode === 'buildroot' ? frame?.buildroot : frame?.rpios
  return settings?.legacySourceBuild === true
}
