import type { FrameScene, FrameSceneSettings, FrameType, SceneApp } from '../types'
import { hasCompiledNimAppSource } from './sceneApps'

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
  // Through normalizeSceneExecution, not the raw stored value: an unknown
  // stamp ("banana") must read as interpreted here exactly as
  // scene_execution does on the backend, or this plane would compile a scene
  // the other one interprets (docs/scene-execution-fixtures.json pins it).
  return normalizeSceneExecution(scene)
}

export function sceneIsCompiledForFrame(
  scene: Partial<FrameScene> | null | undefined,
  mode?: FrameType['mode'] | null
): boolean {
  return sceneExecutionForFrame(scene, mode) !== 'interpreted'
}

/**
 * The value to materialize on a scene that arrives without one (template,
 * import, chat, cloud): an explicit choice wins, otherwise interpreted. Nothing
 * infers `compiled` any more — a scene that carries Nim the interpreter cannot
 * run is flagged by Scene Settings (`sceneRequiresCompilation`) and converted,
 * not silently put on the legacy build path. Mirrors `infer_scene_execution`
 * on the backend.
 */
export function normalizeSceneExecution(
  scene: Partial<FrameScene> | null | undefined
): NonNullable<FrameSceneSettings['execution']> {
  const explicit = scene?.settings?.execution
  if (explicit === 'compiled' || explicit === 'interpreted') {
    return explicit
  }
  return 'interpreted'
}

/** The hosted Nim → JavaScript converter (docs/nim-to-js-conversion.md). */
export const nimConverterUrl = 'https://scenes.frameos.net/nim-converter'

/** The preview banner every surface shows when it runs a compiled scene through the interpreter. */
export const previewSkipsNimMessage =
  "Preview runs the interpreter: this scene's Nim code nodes and Nim apps are not executed here. Convert the scene to JavaScript to see it whole."

export const compiledSceneConfirmMessage =
  'This makes the scene compiled (legacy): it will need a full FrameOS source build on every deploy.\n\n' +
  `Keep it interpreted instead and convert it to an interpreted scene at ${nimConverterUrl}?

` +
  'OK = make the scene compiled. Cancel = keep it interpreted.'

/**
 * The one place a scene may still become compiled: installing or saving an
 * app that only has Nim sources. Returns whether the flip may happen — true
 * without asking when the scene is already compiled or nothing forces it,
 * otherwise the user's answer. `force` asks regardless of `apps` (EditApp
 * knows the sources it is about to save).
 */
export function confirmSceneBecomesCompiled(
  scene: Partial<FrameScene> | null | undefined,
  apps: Record<string, SceneApp>,
  force = false
): boolean {
  if (scene?.settings?.execution === 'compiled') {
    return true
  }
  if (!force && !Object.values(apps).some((app) => hasCompiledNimAppSource(app.sources))) {
    return false
  }
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    return false
  }
  return window.confirm(compiledSceneConfirmMessage)
}
