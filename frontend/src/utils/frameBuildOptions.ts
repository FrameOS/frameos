export type FrameCompilationMode = 'static' | 'shared' | 'shared-scenes' | 'precompiled'
export type FrameCompilationModeOptionValue = '' | FrameCompilationMode

export interface FrameBuildOption<T extends string = string> {
  value: T
  label: string
}

export const frameCompilationModeOptions: FrameBuildOption<FrameCompilationModeOptionValue>[] = [
  { value: '', label: 'Use binaries if possible, compile from source if not' },
  { value: 'precompiled', label: 'Use precompiled binaries if exist for target OS' },
  { value: 'static', label: 'Compile a single binary' },
  { value: 'shared', label: 'Compile drivers and scenes separately' },
  { value: 'shared-scenes', label: 'Compile drivers separately, scenes as one library' },
]

export function normalizeFrameCompilationMode(value: unknown): FrameCompilationMode {
  return value === 'static' || value === 'shared' || value === 'shared-scenes' || value === 'precompiled'
    ? value
    : 'precompiled'
}
