import { FrameScene } from '../types'
import { sceneRefreshSeconds } from './refreshInterval'

/**
 * Scene rhythm, as the editor can know it before a deploy.
 *
 * On a frame every embedded scene renders when IT is due (docs/scene-rhythm.md),
 * on the refresh interval its state holds (utils/refreshInterval.ts). A scene
 * the split drawer generated draws nothing itself, so it has no interval of
 * its own — it follows its cells.
 */

export interface SceneRhythm {
  /** Seconds between renders; null when nothing says. */
  seconds: number | null
  /** Where the number came from: the scene's own interval, or its fastest panel. */
  source: 'interval' | 'children'
}

/** True for scenes that render when their embedded scenes do (generated splits). */
export function sceneFollowsChildren(scene: Pick<FrameScene, 'settings'> | null | undefined): boolean {
  const layout = scene?.settings?.splitScreenLayout
  return !!layout && typeof layout === 'object'
}

/**
 * How often `scene` renders when embedded with `state` (the scene node's
 * config — a split cell's option overrides, the refresh interval among them).
 * `scenes` resolves the scenes a split embeds; `fallbackInterval` is the frame's.
 */
export function sceneRhythm(
  scene: FrameScene,
  state: Record<string, any> = {},
  scenes: Map<string, FrameScene> | FrameScene[] = [],
  fallbackInterval = 300,
  depth = 0
): SceneRhythm {
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
      if (rhythm.seconds !== null) {
        soonest = soonest === null ? rhythm.seconds : Math.min(soonest, rhythm.seconds)
      }
    }
    if (soonest !== null) {
      return { seconds: soonest, source: 'children' }
    }
  }
  // The interval is a state field every scene has (utils/refreshInterval.ts):
  // the panel's override if it set one, else the scene's own default.
  const seconds = sceneRefreshSeconds(scene, state)
  return { seconds: seconds > 0 ? seconds : fallbackInterval, source: 'interval' }
}

/** "every 10 min", "every 0.2 s", "5× a second". */
export function describeRhythmSeconds(seconds: number): string {
  if (seconds < 1) {
    const perSecond = 1 / Math.max(seconds, 0.001)
    return perSecond >= 2 ? `${Math.round(perSecond)}× a second` : `every ${+seconds.toFixed(2)} s`
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
  if (rhythm.seconds === null) {
    return 'when its panels are due'
  }
  const text = describeRhythmSeconds(rhythm.seconds)
  return rhythm.source === 'children' ? `${text} (its fastest panel)` : text
}
