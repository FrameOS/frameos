import { FrameScene } from '../types'

/**
 * Scene rhythm, as the editor can know it before a deploy.
 *
 * On a frame every embedded scene renders when IT is due (docs/scene-rhythm.md):
 * its own `logic/nextSleepDuration` if it has one, else its refresh interval.
 * A scene the split drawer generated draws nothing itself, so it has no
 * interval of its own — it follows its cells.
 */

export interface SceneRhythm {
  /** Seconds between renders; null when the scene decides while it runs. */
  seconds: number | null
  /** Where the number came from. */
  source: 'interval' | 'nextSleep' | 'children' | 'runtime'
}

/** True for scenes that render when their embedded scenes do (generated splits). */
export function sceneFollowsChildren(scene: Pick<FrameScene, 'settings'> | null | undefined): boolean {
  const layout = scene?.settings?.splitScreenLayout
  return !!layout && typeof layout === 'object'
}

function toSeconds(value: unknown): number | null {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? parseFloat(value) : NaN
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

/**
 * How often `scene` renders when embedded with `state` (the scene node's
 * config — a split cell's option overrides). `scenes` resolves the scenes a
 * split embeds; `fallbackInterval` is the frame's.
 */
export function sceneRhythm(
  scene: FrameScene,
  state: Record<string, any> = {},
  scenes: Map<string, FrameScene> | FrameScene[] = [],
  fallbackInterval = 300,
  depth = 0
): SceneRhythm {
  const nodes = scene.nodes ?? []
  const edges = scene.edges ?? []

  // A scene that paces itself: logic/nextSleepDuration, with the duration
  // either set on the node or wired from a state field ("secondsBetweenImages").
  for (const node of nodes) {
    const data = node.data as { keyword?: string; config?: Record<string, any> } | undefined
    if (node.type !== 'app' || data?.keyword !== 'logic/nextSleepDuration') {
      continue
    }
    const wired = edges.find((edge) => edge.target === node.id && edge.targetHandle === 'fieldInput/duration')
    if (!wired) {
      const seconds = toSeconds(data?.config?.duration)
      return seconds === null ? { seconds: null, source: 'runtime' } : { seconds, source: 'nextSleep' }
    }
    const source = nodes.find((candidate) => candidate.id === wired.source)
    const fieldName = source?.type === 'state' ? (source.data as { keyword?: string })?.keyword : undefined
    if (fieldName) {
      const field = (scene.fields ?? []).find((candidate) => candidate.name === fieldName)
      const seconds = toSeconds(state[fieldName] ?? field?.value)
      if (seconds !== null) {
        return { seconds, source: 'nextSleep' }
      }
    }
    // Computed by a code node: only the frame knows.
    return { seconds: null, source: 'runtime' }
  }

  if (sceneFollowsChildren(scene) && depth < 8) {
    const lookup = scenes instanceof Map ? scenes : new Map(scenes.map((candidate) => [candidate.id, candidate]))
    let soonest: number | null = null
    let unknown = false
    for (const node of nodes) {
      if (node.type !== 'scene') {
        continue
      }
      const data = node.data as { keyword?: string; config?: Record<string, any> }
      const child = data?.keyword ? lookup.get(data.keyword) : undefined
      if (!child) {
        continue
      }
      const rhythm = sceneRhythm(child, data.config ?? {}, lookup, fallbackInterval, depth + 1)
      if (rhythm.seconds === null) {
        unknown = true
      } else {
        soonest = soonest === null ? rhythm.seconds : Math.min(soonest, rhythm.seconds)
      }
    }
    if (soonest !== null) {
      return { seconds: soonest, source: 'children' }
    }
    if (unknown) {
      return { seconds: null, source: 'runtime' }
    }
  }

  return { seconds: toSeconds(scene.settings?.refreshInterval) ?? fallbackInterval, source: 'interval' }
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
    return 'paces itself'
  }
  const text = describeRhythmSeconds(rhythm.seconds)
  return rhythm.source === 'children' ? `${text} (its fastest panel)` : text
}
