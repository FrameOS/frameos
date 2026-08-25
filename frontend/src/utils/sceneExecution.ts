import type { FrameScene, FrameSceneSettings, FrameType } from '../types'
import { sceneRequiresCompilation } from './sceneApps'

export function frameRunsScenesInterpreted(mode?: FrameType['mode'] | null): boolean {
  return mode === 'embedded'
}

/**
 * Interpreted is the default: every scene the UI creates is stamped
 * `execution: 'interpreted'`, and the backend reads an absent key the same
 * way (app/utils/scene_execution.py). Compiled is the legacy mode, chosen
 * explicitly for scenes that still carry inline Nim.
 */
export function sceneExecutionForFrame(
  scene: Partial<FrameScene> | null | undefined,
  mode?: FrameType['mode'] | null
): NonNullable<FrameSceneSettings['execution']> {
  if (frameRunsScenesInterpreted(mode)) {
    return 'interpreted'
  }
  return scene?.settings?.execution ?? 'interpreted'
}

export function sceneIsCompiledForFrame(
  scene: Partial<FrameScene> | null | undefined,
  mode?: FrameType['mode'] | null
): boolean {
  return sceneExecutionForFrame(scene, mode) !== 'interpreted'
}

/**
 * The value to materialize on a scene that arrives without one (template,
 * import, chat, cloud): keep an explicit choice, otherwise compiled only if
 * the scene has content the interpreter cannot run. Mirrors
 * `infer_scene_execution` on the backend.
 */
export function normalizeSceneExecution(
  scene: Partial<FrameScene> | null | undefined
): NonNullable<FrameSceneSettings['execution']> {
  const explicit = scene?.settings?.execution
  if (explicit === 'compiled' || explicit === 'interpreted') {
    return explicit
  }
  return scene && sceneRequiresCompilation(scene) ? 'compiled' : 'interpreted'
}
