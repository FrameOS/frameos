import type { FrameScene, FrameSceneSettings, FrameType } from '../types'

export function frameRunsScenesInterpreted(mode?: FrameType['mode'] | null): boolean {
  return mode === 'embedded'
}

export function sceneExecutionForFrame(
  scene: Partial<FrameScene> | null | undefined,
  mode?: FrameType['mode'] | null
): NonNullable<FrameSceneSettings['execution']> {
  if (frameRunsScenesInterpreted(mode)) {
    return 'interpreted'
  }
  return scene?.settings?.execution ?? 'compiled'
}

export function sceneIsCompiledForFrame(
  scene: Partial<FrameScene> | null | undefined,
  mode?: FrameType['mode'] | null
): boolean {
  return sceneExecutionForFrame(scene, mode) !== 'interpreted'
}
