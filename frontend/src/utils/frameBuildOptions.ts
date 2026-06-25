import versions from '../../../versions.json'

export type FrameCompilationMode = 'static' | 'shared' | 'shared-scenes' | 'precompiled'
export type FrameCompilationModeOptionValue = '' | FrameCompilationMode

export interface FrameBuildOption<T extends string = string> {
  value: T
  label: string
}

export const frameCompilationModeOptions: FrameBuildOption<FrameCompilationModeOptionValue>[] = [
  { value: '', label: 'Prefer binaries, build from source if needed' },
  { value: 'precompiled', label: `Install precompiled binaries (version ${versions.frameos.split('+')[0]})` },
  { value: 'static', label: 'Build from source - single binary' },
  { value: 'shared', label: 'Build from source - drivers and scenes separately' },
  { value: 'shared-scenes', label: 'Build from source - drivers separately, scenes combined' },
]

export function normalizeFrameCompilationMode(value: unknown): FrameCompilationMode {
  return value === 'static' || value === 'shared' || value === 'shared-scenes' || value === 'precompiled'
    ? value
    : 'precompiled'
}
