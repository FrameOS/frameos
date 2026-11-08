// Layouts (docs/scene-layouts.md): a layout is a regular scene marked
// `settings.isLayout` that draws other scenes inside its chrome. Which layout
// an installed scene wears is the INSTALL's choice, `layout` beside `nodes`
// like the button map (`eventMap`): a scene update keeps it, and templates,
// zips and store versions never carry it.
//
// Import-light on purpose: the cloud's node test suite exercises it directly.
import type { FrameScene, SceneLayoutRef } from '../types'

export function isLayoutScene(scene: Pick<FrameScene, 'settings'> | null | undefined): boolean {
  return scene?.settings?.isLayout === true
}

/** The scenes a person picks between: every list but the Layouts group. */
export function scenesWithoutLayouts<T extends Pick<FrameScene, 'settings'>>(
  scenes: readonly T[] | null | undefined
): T[] {
  return (scenes ?? []).filter((scene) => !isLayoutScene(scene))
}

export function layoutScenes<T extends Pick<FrameScene, 'settings'>>(scenes: readonly T[] | null | undefined): T[] {
  return (scenes ?? []).filter(isLayoutScene)
}

/** A `layout` value as the runtime reads it, or null when it is not one. */
export function sceneLayoutRef(value: unknown): SceneLayoutRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const { sceneId, state } = value as { sceneId?: unknown; state?: unknown }
  if (typeof sceneId !== 'string' || !sceneId) {
    return null
  }
  return state && typeof state === 'object' && !Array.isArray(state) && Object.keys(state).length > 0
    ? { sceneId, state: state as Record<string, any> }
    : { sceneId }
}

export function withSceneLayout<T extends Partial<FrameScene>>(scene: T, layout: SceneLayoutRef | null): T {
  const { layout: _dropped, ...rest } = scene as T & { layout?: unknown }
  const ref = sceneLayoutRef(layout)
  return (ref ? { ...rest, layout: ref } : rest) as T
}

/** The scene without the installed copy's layout: what a template, a zip or a store version carries. */
export function withoutSceneLayout<T extends Partial<FrameScene>>(scene: T): T {
  if (!scene || !('layout' in scene)) {
    return scene
  }
  const { layout: _dropped, ...rest } = scene as T & { layout?: unknown }
  return rest as T
}

/**
 * The layout a scene wears, by what the frame still has: a layout deleted
 * since reads as none (the runtime draws such a scene without one too).
 */
export function currentSceneLayout(
  scene: Pick<FrameScene, 'layout'> | null | undefined,
  layouts: readonly Pick<FrameScene, 'id'>[]
): SceneLayoutRef | null {
  const ref = sceneLayoutRef(scene?.layout)
  return ref && layouts.some((layout) => layout.id === ref.sceneId) ? ref : null
}
