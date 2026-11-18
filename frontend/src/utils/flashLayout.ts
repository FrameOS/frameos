// The layout a frame starts with, chosen where its card or board is flashed
// (docs/scene-layouts.md "Control planes", "Chosen at the flash"): "No
// layout", one the frame already has, or a starter from the repository's
// samples (`LAYOUT_STARTERS`), with its public fields set by the gear beside
// the select.
//
// The choice becomes what the frame's own Layout select would have made of
// it: the layout installed on the frame and worn by every scene (`layout:
// {sceneId, state}` beside `nodes`), so it reaches the device the way any
// layout does on either plane. A starter's copy also takes the gear's values
// as its fields' defaults: a frame flashed before it has any scenes keeps
// them for the scenes that join it (`withActiveLayoutOnNewScenes`).
//
// Import-light on purpose: the cloud's node test suite exercises it directly.
import type { FrameScene, SceneLayoutRef } from '../types'
import { activeFrameLayout, isLayoutScene, layoutScenes, withLayoutOnEveryScene, withSceneLayout } from './sceneLayouts'

/** The select's value for "No layout". */
export const NO_FLASH_LAYOUT = ''
const FRAME_PREFIX = 'frame:'
const STARTER_PREFIX = 'starter:'

/** The select's value for a layout the frame already has. */
export function frameLayoutChoice(sceneId: string): string {
  return `${FRAME_PREFIX}${sceneId}`
}

/** The select's value for a starter, by its name. */
export function starterLayoutChoice(name: string): string {
  return `${STARTER_PREFIX}${name}`
}

export interface FlashLayoutStarter {
  name: string
  scene: FrameScene
}

/** What the flash does with the frame's layouts. */
export type FlashLayoutPick =
  | { kind: 'none' }
  | { kind: 'frame'; sceneId: string; state: Record<string, any> }
  | { kind: 'starter'; scene: FrameScene; state: Record<string, any> }

/** The select's value before anyone touches it: the layout the frame wears now, else "No layout". */
export function initialFlashLayoutChoice(
  frameScenes: readonly Pick<FrameScene, 'id' | 'layout' | 'settings'>[] | null | undefined
): string {
  const active = activeFrameLayout(frameScenes)
  return active ? frameLayoutChoice(active.sceneId) : NO_FLASH_LAYOUT
}

/** The layout scene a choice names, among the frame's layouts and the starters; null for none. */
export function flashLayoutScene(
  choice: string,
  frameScenes: readonly FrameScene[] | null | undefined,
  starters: readonly FlashLayoutStarter[]
): FrameScene | null {
  if (choice.startsWith(FRAME_PREFIX)) {
    const sceneId = choice.slice(FRAME_PREFIX.length)
    return layoutScenes(frameScenes).find((scene) => scene.id === sceneId) ?? null
  }
  if (choice.startsWith(STARTER_PREFIX)) {
    const name = choice.slice(STARTER_PREFIX.length)
    return starters.find((starter) => starter.name === name)?.scene ?? null
  }
  return null
}

/** The values the gear starts from: what the frame's scenes give the layout now, for one it already wears. */
export function flashLayoutStartingState(
  choice: string,
  frameScenes: readonly Pick<FrameScene, 'id' | 'layout' | 'settings'>[] | null | undefined
): Record<string, any> {
  const active = activeFrameLayout(frameScenes)
  return active && choice === frameLayoutChoice(active.sceneId) ? { ...(active.state ?? {}) } : {}
}

/** What a choice does, or null when it names nothing the frame or the starters have. */
export function flashLayoutPick(
  choice: string,
  state: Record<string, any>,
  frameScenes: readonly FrameScene[] | null | undefined,
  starters: readonly FlashLayoutStarter[]
): FlashLayoutPick | null {
  if (choice === NO_FLASH_LAYOUT) {
    return { kind: 'none' }
  }
  const scene = flashLayoutScene(choice, frameScenes, starters)
  if (!scene) {
    return null
  }
  return choice.startsWith(FRAME_PREFIX)
    ? { kind: 'frame', sceneId: scene.id, state }
    : { kind: 'starter', scene, state }
}

/** The scene with these values as its fields' defaults (a field not named keeps its own). */
export function withStateAsFieldDefaults<T extends Partial<FrameScene>>(scene: T, state: Record<string, any>): T {
  if (!scene.fields || Object.keys(state).length === 0) {
    return scene
  }
  return {
    ...scene,
    fields: scene.fields.map((field) =>
      field && 'name' in field && typeof field.name === 'string' && field.name in state
        ? { ...field, value: state[field.name] }
        : field
    ),
  }
}

function layoutRef(sceneId: string, state: Record<string, any>): SceneLayoutRef {
  return Object.keys(state).length > 0 ? { sceneId, state: { ...state } } : { sceneId }
}

/** Every scene that is not a layout wears this one, with these settings. */
function wearing(scenes: readonly FrameScene[], ref: SceneLayoutRef): FrameScene[] {
  return scenes.map((scene) => (isLayoutScene(scene) ? scene : withSceneLayout(scene, ref)))
}

/**
 * The frame's scenes once the flash's layout is on them. A starter is
 * installed as a copy with its own id (`newId`), unless the frame already has
 * a layout of that name, which is worn instead: flashing a card again must
 * not add the same desktop twice.
 */
export function scenesWithFlashLayout(
  frameScenes: readonly FrameScene[] | null | undefined,
  pick: FlashLayoutPick,
  newId: () => string
): FrameScene[] {
  const scenes = [...(frameScenes ?? [])]
  if (pick.kind === 'none') {
    return withLayoutOnEveryScene(scenes, '')
  }
  if (pick.kind === 'frame') {
    return wearing(scenes, layoutRef(pick.sceneId, pick.state))
  }
  const name = pick.scene.name
  const existing = layoutScenes(scenes).find((scene) => !!name && scene.name === name)
  if (existing) {
    return wearing(scenes, layoutRef(existing.id, pick.state))
  }
  const copy = installedLayoutCopy(pick.scene, pick.state, newId())
  return [...wearing(scenes, layoutRef(copy.id, pick.state)), copy]
}

/** A starter as installed on a frame: its own id, the gear's values as its defaults, never the frame's default scene. */
export function installedLayoutCopy(scene: FrameScene, state: Record<string, any>, id: string): FrameScene {
  const {
    default: _default,
    layout: _layout,
    origin: _origin,
    ...rest
  } = scene as FrameScene & {
    default?: boolean
    origin?: unknown
  }
  return withStateAsFieldDefaults({ ...rest, id } as FrameScene, state)
}
