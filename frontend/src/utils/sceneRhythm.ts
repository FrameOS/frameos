import { FrameScene } from '../types'
import { sceneRefreshSeconds } from './refreshInterval'

/**
 * How often a scene renders, as the editor can tell before a deploy.
 *
 * On a frame every scene drawn through a scene node renders when IT is due
 * (frameos/src/frameos/scene_rhythm.nim), on the refresh interval its state
 * holds (utils/refreshInterval.ts). A scene the split drawer generated draws
 * nothing of its own: its interval is the fastest it renders, and it waits
 * longer when none of its panels is due by then.
 */

export interface SceneRhythm {
  /** Seconds between renders. */
  seconds: number
  /** Where the number came from: the scene's own interval, or its panels being slower. */
  source: 'interval' | 'children'
}

/** True for scenes that render when their embedded scenes do (generated splits). */
export function sceneFollowsChildren(scene: Pick<FrameScene, 'settings'> | null | undefined): boolean {
  const layout = scene?.settings?.splitScreenLayout
  return !!layout && typeof layout === 'object'
}

/**
 * How often `scene` renders when embedded with `state` (the scene node's
 * config: a split panel's option overrides, the refresh interval among them).
 * `scenes` resolves the scenes a split embeds; `fallbackInterval` is the frame's.
 */
export function sceneRhythm(
  scene: FrameScene,
  state: Record<string, any> = {},
  scenes: Map<string, FrameScene> | FrameScene[] = [],
  fallbackInterval = 300,
  depth = 0
): SceneRhythm {
  // The interval is a state field every scene has (utils/refreshInterval.ts):
  // the panel's override if it set one, else the scene's own default.
  const own = sceneRefreshSeconds(scene, state)
  const ownSeconds = own > 0 ? own : fallbackInterval
  if (sceneFollowsChildren(scene) && depth < 8) {
    const lookup = scenes instanceof Map ? scenes : new Map(scenes.map((candidate) => [candidate.id, candidate]))
    let soonest: number | null = null
    for (const node of scene.nodes ?? []) {
      if (node.type !== 'scene') {
        continue
      }
      const data = node.data as { keyword?: string; config?: Record<string, any> }
      const child = data?.keyword ? lookup.get(data.keyword) : undefined
      if (!child) {
        continue
      }
      const rhythm = sceneRhythm(child, data.config ?? {}, lookup, fallbackInterval, depth + 1)
      soonest = soonest === null ? rhythm.seconds : Math.min(soonest, rhythm.seconds)
    }
    if (soonest !== null && soonest > ownSeconds) {
      return { seconds: soonest, source: 'children' }
    }
  }
  return { seconds: ownSeconds, source: 'interval' }
}

/** "every 10 min", "every 0.2 s", "5 times a second". */
export function describeRhythmSeconds(seconds: number): string {
  if (seconds < 1) {
    const perSecond = 1 / Math.max(seconds, 0.001)
    return perSecond >= 2 ? `${Math.round(perSecond)} times a second` : `every ${+seconds.toFixed(2)} s`
  }
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'h'],
    [60, 'min'],
  ]
  for (const [size, unit] of units) {
    if (seconds >= size) {
      const amount = +(seconds / size).toFixed(1)
      if (unit === 'day') {
        return amount === 1 ? 'every day' : `every ${amount} days`
      }
      return `every ${amount} ${unit}`
    }
  }
  return `every ${+seconds.toFixed(1)} s`
}

export function describeSceneRhythm(rhythm: SceneRhythm): string {
  const text = describeRhythmSeconds(rhythm.seconds)
  return rhythm.source === 'children' ? `${text} (its fastest panel)` : text
}

/** The hint under a generated split's refresh interval, or null for any other scene. */
export function splitSceneRhythmHint(
  scene: FrameScene | null,
  scenes: FrameScene[],
  fallbackInterval: number
): string | null {
  if (!scene || !sceneFollowsChildren(scene)) {
    return null
  }
  const rhythm = sceneRhythm(scene, {}, scenes, fallbackInterval)
  return `Each panel renders on its own schedule, at most this often. With these panels: ${describeSceneRhythm(
    rhythm
  )}.`
}

/**
 * When a split panel renders, from its options and the split's own interval
 * (the fastest the split renders), or null when the panel is empty.
 */
export function splitPanelRhythm(
  panelScene: FrameScene | null,
  panelState: Record<string, any> | null | undefined,
  scenes: FrameScene[],
  fallbackInterval: number,
  splitSeconds: number
): string | null {
  if (!panelScene) {
    return null
  }
  const rhythm = sceneRhythm(panelScene, panelState ?? {}, scenes, fallbackInterval)
  return rhythm.seconds < splitSeconds
    ? `${describeRhythmSeconds(splitSeconds)} (the split's interval)`
    : describeSceneRhythm(rhythm)
}
