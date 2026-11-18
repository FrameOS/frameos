/**
 * What a scene needs of the frame it runs on, read from its own JSON: the
 * store's "fits" badges and filter (docs/scene-store.md "What a scene
 * needs"). Not a category: a game can be a touch game on e-paper or an
 * arcade game that only plays on a fast screen, and the store's shelves say
 * what a scene is about, never which panel it is for.
 *
 * - `fast`: a fast screen (an LCD or HDMI). The scene redraws more than once a
 *   second (`refreshInterval` under 1 s): animation, a game loop, smooth
 *   motion. E-paper cannot show it, and a frame's own store leaves it out
 *   there.
 * - `touch`: it is used with taps or a mouse (JSX handlers, pointer events).
 * - `keys`: it is used with a keyboard or the frame's buttons.
 * - `linux`: it runs a program on a Linux frame (Chromium, FFmpeg, a shell
 *   command), which an ESP32 and a cloud-managed frame refuse.
 *
 * The cloud store works them out at publish time and keeps them on the
 * version (`needs`, cloud/apps/auth-web/src/lib/store.ts), beside the risk
 * flags of sceneAccess.ts. A layout's own redraws are not a scene's: a layout
 * never needs a fast screen.
 *
 * Plain TypeScript on unknown input, no imports: the cloud server compiles it
 * under its stricter tsconfig.
 */

export type SceneNeed = 'fast' | 'touch' | 'keys' | 'linux'
export const SCENE_NEEDS: readonly SceneNeed[] = ['fast', 'touch', 'keys', 'linux']

const needLabels: Record<SceneNeed, string> = {
  fast: 'Fast screen',
  touch: 'Touch',
  keys: 'Keys',
  linux: 'Pi only',
}

const needDescriptions: Record<SceneNeed, string> = {
  fast: 'Redraws many times a second: made for an LCD or HDMI screen. E-paper cannot keep up.',
  touch: 'Used with taps, swipes or a mouse.',
  keys: "Used with a keyboard or the frame's buttons.",
  linux: 'Runs a program on the frame (Chromium, FFmpeg or a shell command): a Raspberry Pi only, not an ESP32 or a cloud-managed frame.',
}

export function sceneNeedLabel(need: SceneNeed): string {
  return needLabels[need]
}

export function sceneNeedDescription(need: SceneNeed): string {
  return needDescriptions[need]
}

export function isSceneNeed(value: unknown): value is SceneNeed {
  return typeof value === 'string' && (SCENE_NEEDS as readonly string[]).includes(value)
}

/** The known needs among stored ones, in SCENE_NEEDS order. */
export function knownSceneNeeds(needs: readonly unknown[] | null | undefined): SceneNeed[] {
  const have = new Set((needs ?? []).filter(isSceneNeed))
  return SCENE_NEEDS.filter((need) => have.has(need))
}

/** Pointer events by the contract's names, old aliases included (docs/events-contract.json). */
const POINTER_EVENTS = new Set([
  'pointerDown',
  'pointerMove',
  'pointerUp',
  'pointerCancel',
  'tap',
  'doubleTap',
  'longPress',
  'swipe',
  'edgeSwipe',
  'pinch',
  'wheel',
  'click',
  'mouseDown',
  'mouseMove',
  'mouseUp',
  'touchStart',
  'touchMove',
  'touchEnd',
])

/** Keys and the frame's own buttons. */
const KEY_EVENTS = new Set(['keyDown', 'keyUp', 'textInput', 'button'])

/** Built-in apps that start a program on the frame (sceneAccess.ts gives them `shell`). */
const LINUX_APPS = new Set(['data/chromiumScreenshot', 'data/rstpSnapshot'])

const POINTER_HANDLER =
  /\bon(?:Click|DoubleClick|Tap|DoubleTap|LongPress|Press|PressIn|PressOut|Pointer(?:Down|Up|Move|Enter|Leave|Cancel)|Mouse(?:Down|Up|Move)|Touch(?:Start|Move|End)|Drag(?:Start|End)?|Swipe|Wheel|Scroll)\s*[=:]/
const KEY_HANDLER = /\bon(?:KeyDown|KeyUp|KeyPress|TextInput)\s*[=:]/
const POINTER_NAME = new RegExp(`['"\`](?:${[...POINTER_EVENTS].join('|')})['"\`]`)
// Not 'button': JSX says look="button" and type="button" for what a tap presses.
const KEY_NAME = /['"`](?:keyDown|keyUp|textInput)['"`]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function scenesOf(scenes: unknown): Record<string, unknown>[] {
  if (Array.isArray(scenes)) {
    return scenes.filter(isRecord)
  }
  return isRecord(scenes) ? [scenes] : []
}

function settingsOf(scene: Record<string, unknown>): Record<string, unknown> {
  return isRecord(scene.settings) ? scene.settings : {}
}

function isLayout(scene: Record<string, unknown>): boolean {
  return settingsOf(scene).isLayout === true
}

function nodesOf(scene: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(scene.nodes) ? scene.nodes.filter(isRecord) : []
}

function dataOf(node: Record<string, unknown>): Record<string, unknown> {
  return isRecord(node.data) ? node.data : {}
}

/** Every source text of a scene's JS apps and code nodes, config.json excluded. */
function codeOf(scene: Record<string, unknown>): string[] {
  const texts: string[] = []
  const apps = isRecord(scene.apps) ? scene.apps : {}
  for (const app of Object.values(apps)) {
    const sources = isRecord(app) && isRecord(app.sources) ? app.sources : {}
    for (const [file, text] of Object.entries(sources)) {
      if (typeof text === 'string' && file !== 'config.json' && !file.endsWith('.json')) {
        texts.push(text)
      }
    }
  }
  for (const node of nodesOf(scene)) {
    const data = dataOf(node)
    if (node.type === 'code' && typeof data.code === 'string') {
      texts.push(data.code)
    }
  }
  return texts
}

/** The events a scene's JS apps subscribe to in their config.json (`events`). */
function appEventsOf(scene: Record<string, unknown>): string[] {
  const events: string[] = []
  const apps = isRecord(scene.apps) ? scene.apps : {}
  for (const app of Object.values(apps)) {
    const sources = isRecord(app) && isRecord(app.sources) ? app.sources : {}
    const config = sources['config.json']
    if (typeof config !== 'string') {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(config)
      if (isRecord(parsed) && Array.isArray(parsed.events)) {
        events.push(...parsed.events.filter((name): name is string => typeof name === 'string'))
      }
    } catch {
      // not JSON: no events
    }
  }
  return events
}

function refreshIntervalOf(scene: Record<string, unknown>): number | null {
  const value = settingsOf(scene).refreshInterval
  const seconds = typeof value === 'string' ? Number(value) : value
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/** What one scene needs (a layout never needs a fast screen). */
export function sceneNeedsForScene(scene: unknown, riskFlags: readonly string[] = []): SceneNeed[] {
  const needs = new Set<SceneNeed>()
  for (const entry of scenesOf(scene)) {
    const interval = refreshIntervalOf(entry)
    if (!isLayout(entry) && interval !== null && interval < 1) {
      needs.add('fast')
    }
    const events = new Set<string>(appEventsOf(entry))
    for (const node of nodesOf(entry)) {
      const data = dataOf(node)
      if (node.type === 'event' && typeof data.keyword === 'string') {
        events.add(data.keyword)
      }
      if (node.type === 'app' && typeof data.keyword === 'string' && LINUX_APPS.has(data.keyword)) {
        needs.add('linux')
      }
    }
    const code = codeOf(entry)
    if ([...events].some((name) => POINTER_EVENTS.has(name)) || code.some((text) => POINTER_HANDLER.test(text) || POINTER_NAME.test(text))) {
      needs.add('touch')
    }
    if ([...events].some((name) => KEY_EVENTS.has(name)) || code.some((text) => KEY_HANDLER.test(text) || KEY_NAME.test(text))) {
      needs.add('keys')
    }
  }
  if (riskFlags.includes('shell')) {
    needs.add('linux')
  }
  return SCENE_NEEDS.filter((need) => needs.has(need))
}

/** What a whole scenes.json needs: the union over its scenes. */
export function sceneNeeds(scenes: unknown, riskFlags: readonly string[] = []): SceneNeed[] {
  return sceneNeedsForScene(scenesOf(scenes), riskFlags)
}

/** What a frame can do, as its own store app and the store front ask (docs/scene-store.md). */
export interface FrameFit {
  /** A fast screen: an LCD or HDMI. */
  fast?: boolean
  /** Runs Linux programs: a Pi frame that is not cloud-managed. */
  linux?: boolean
}

/**
 * Whether a scene with these needs can run on such a frame. Touch and keys
 * never rule a scene out: a frame's buttons and the frame page reach any
 * scene, and a frame's own store is itself used by taps.
 */
export function sceneFitsFrame(needs: readonly unknown[] | null | undefined, frame: FrameFit): boolean {
  const known = knownSceneNeeds(needs)
  if (known.includes('fast') && frame.fast === false) {
    return false
  }
  if (known.includes('linux') && frame.linux === false) {
    return false
  }
  return true
}
