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

/** `settings` with the scene made a layout or a normal one. A normal scene carries no flag. */
export function withIsLayout<T extends object>(settings: T | null | undefined, isLayout: boolean): T {
  const { isLayout: _dropped, ...rest } = (settings ?? {}) as T & { isLayout?: boolean }
  return (isLayout ? { ...rest, isLayout: true } : rest) as unknown as T
}

/** The scene a saved pack of scenes stands for: the one it starts on, else the first. */
export function mainScene<T extends Pick<FrameScene, 'default'>>(scenes: readonly T[] | null | undefined): T | null {
  return scenes?.find((scene) => scene.default) ?? scenes?.[0] ?? null
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
 * Every scene on the list wears this layout (`''`: none). Layouts themselves
 * are left alone, and a scene already wearing it keeps its settings.
 */
export function withLayoutOnEveryScene<T extends Partial<FrameScene>>(
  scenes: readonly T[],
  layoutSceneId: string
): T[] {
  return scenes.map((scene) => {
    if (isLayoutScene(scene as Pick<FrameScene, 'settings'>)) {
      return scene
    }
    const worn = sceneLayoutRef(scene.layout)
    return withSceneLayout(
      scene,
      !layoutSceneId ? null : worn?.sceneId === layoutSceneId ? worn : { sceneId: layoutSceneId }
    )
  })
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

/** The layout id every scene shares (`''`: none of them wears one), or null when they differ. */
export function commonSceneLayoutId(
  scenes: readonly Pick<FrameScene, 'layout'>[],
  layouts: readonly Pick<FrameScene, 'id'>[]
): string | null {
  const ids = new Set(scenes.map((scene) => currentSceneLayout(scene, layouts)?.sceneId ?? ''))
  return ids.size > 1 ? null : [...ids][0] ?? ''
}
