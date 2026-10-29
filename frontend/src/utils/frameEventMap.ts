// The frame's event map (docs/events.md, "Event map") as the Settings panel's
// "Button actions" sees it.
//
// A frame's buttons do something whatever scene is showing: a reTerminal's
// LEFT held is the previous scene, RIGHT held the next, on every preset. The
// map is frame.json `eventMap` (`event_map` on the wire), a list of rules the
// device's dispatcher applies before any scene is asked; a rule with `emit`
// replaces the press with the event it names and the scene never hears it.
// A touch screen's swipes in from an edge (`edgeSwipe`) are bound the same
// way: in from the left `back` and from the right `forward` (the scene's own:
// the photo or the page before or after, never another scene), up from the
// bottom the scene switcher (docs/scene-switcher.md).
// This module turns the rules into the section's rows — one press of one
// button or one edge, one action — and the rows back into rules; rules the
// section did not write (hand-made, a rewrite, another event) are kept as
// they are.
//
// Import-light on purpose (types, the contract tables, the scene map helpers):
// the cloud's node test suite exercises it directly.
import type { EventMapRule, FrameScene } from '../types'
import { cloudFrameSupportsSettingsFrom, isEventMapRule } from './cloudFrameSettings'
import { contractEventSpecs, screenEdges } from './eventsContract.gen'
import { type ButtonGesture, gestureTitle, gestureValue, parseGestureValue } from './sceneEventMap'

export type FrameActionKind =
  | 'nextScene'
  | 'prevScene'
  | 'back'
  | 'forward'
  | 'showScene'
  | 'sceneSwitcher'
  | 'sceneSettings'
  | 'render'
  | 'turnOn'
  | 'turnOff'
  | 'toggleScreen'
  | 'voiceChat'

/** What a bound press does. `sceneId` for `showScene` alone. */
export interface FrameAction {
  kind: FrameActionKind
  sceneId?: string
}

/** A swipe in from one edge of a touch screen (the dispatcher's `edgeSwipe`). */
export interface EdgeGesture {
  edge: string
}

/** What a row binds: a press of one of the frame's buttons, or a swipe in from an edge. */
export type FrameGesture = ButtonGesture | EdgeGesture

/** One row of the section: a press of one of the frame's buttons (or a swipe), and its action. */
export interface ButtonBinding {
  gesture: FrameGesture
  action: FrameAction
}

const ACTION_TITLES: Record<FrameActionKind, string> = {
  nextScene: 'Next scene',
  prevScene: 'Previous scene',
  back: 'Back',
  forward: 'Forward',
  showScene: 'Show scene',
  sceneSwitcher: 'Scene switcher',
  sceneSettings: 'Scene settings',
  render: 'Refresh',
  turnOn: 'Display on',
  turnOff: 'Display off',
  toggleScreen: 'Display on/off',
  voiceChat: 'Voice chat',
}

const EDGE_TITLES: Record<string, string> = {
  left: 'Swipe in from the left',
  right: 'Swipe in from the right',
  top: 'Swipe down from the top',
  bottom: 'Swipe up from the bottom',
}

/** Every scene-less action a rule can mean; `showScene` needs a scene. What a given frame offers is `frameActionKindsFor`. */
export const frameActionKinds: readonly FrameActionKind[] = [
  'nextScene',
  'prevScene',
  'back',
  'forward',
  'sceneSwitcher',
  'sceneSettings',
  'render',
  'turnOn',
  'turnOff',
  'toggleScreen',
]

/** The first FrameOS that shows the scene switcher (the contract's `sceneSwitcher.since`). */
export const sceneSwitcherMinVersion: string = contractEventSpecs.sceneSwitcher.since ?? '0.0.0'

/**
 * Whether a frame on this FrameOS shows the scene switcher. A cloud frame
 * that runs an older one refuses the whole push with `sceneSwitcher` in it;
 * a backend frame without a reported version gets the runtime with its
 * next deploy.
 */
export function frameSupportsSceneSwitcher(frameosVersion: string | null | undefined, cloud: boolean): boolean {
  if (!cloud && (typeof frameosVersion !== 'string' || frameosVersion.trim().length === 0)) {
    return true
  }
  return cloudFrameSupportsSettingsFrom(sceneSwitcherMinVersion, frameosVersion)
}

/** The first FrameOS that shows a scene's settings (the contract's `sceneSettings.since`). */
export const sceneSettingsMinVersion: string = contractEventSpecs.sceneSettings.since ?? '0.0.0'

/** Whether a frame on this FrameOS shows a scene's settings, as `frameSupportsSceneSwitcher`. */
export function frameSupportsSceneSettings(frameosVersion: string | null | undefined, cloud: boolean): boolean {
  if (!cloud && (typeof frameosVersion !== 'string' || frameosVersion.trim().length === 0)) {
    return true
  }
  return cloudFrameSupportsSettingsFrom(sceneSettingsMinVersion, frameosVersion)
}

/** The first FrameOS whose scenes hear `back` and `forward` (the contract's `back.since`). */
export const backForwardMinVersion: string = contractEventSpecs.back.since ?? '0.0.0'

/** Whether a frame on this FrameOS takes `back` / `forward` from its map, as `frameSupportsSceneSwitcher`. */
export function frameSupportsBackForward(frameosVersion: string | null | undefined, cloud: boolean): boolean {
  if (!cloud && (typeof frameosVersion !== 'string' || frameosVersion.trim().length === 0)) {
    return true
  }
  return cloudFrameSupportsSettingsFrom(backForwardMinVersion, frameosVersion)
}

/** What this frame can do with a press, as far as the actions on offer go. */
export interface FrameActionOffer {
  /** The frame has voice chat at all (`useFrameSettings().voiceChat`: a microphone, ESP32 only). */
  voiceChat: boolean
  /**
   * The device can switch its panel off and back on for a press
   * (`deviceSwitchesDisplay`): the framebuffer, the HyperPixels and an ESP32
   * LCD's backlight. On e-paper `turnOn` / `turnOff` / `toggleScreen` switch
   * nothing (docs/events.md, the host table), so the row does not offer them.
   */
  displayPower: boolean
  /** The frame's FrameOS shows the scene switcher (`frameSupportsSceneSwitcher`). */
  sceneSwitcher?: boolean
  /** The frame's FrameOS shows a scene's settings (`frameSupportsSceneSettings`). */
  sceneSettings?: boolean
  /** The frame's FrameOS takes `back` / `forward` (`frameSupportsBackForward`). */
  backForward?: boolean
}

export function isEdgeGesture(gesture: FrameGesture): gesture is EdgeGesture {
  return 'edge' in gesture
}

/** Whether a press can carry voice chat: a key's long press alone. */
export function gestureCanVoiceChat(gesture: FrameGesture): boolean {
  return !isEdgeGesture(gesture) && gesture.action === 'longPress'
}

/** A row's press or swipe as one select value, and back. */
export function frameGestureValue(gesture: FrameGesture): string {
  return isEdgeGesture(gesture) ? JSON.stringify({ edge: gesture.edge }) : gestureValue(gesture)
}

export function parseFrameGestureValue(value: string): FrameGesture | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const edge = (parsed as { edge?: unknown }).edge
      return typeof edge === 'string' && screenEdges.includes(edge) ? { edge } : null
    }
  } catch {
    return null
  }
  return parseGestureValue(value)
}

export function frameGestureTitle(gesture: FrameGesture): string {
  return isEdgeGesture(gesture) ? EDGE_TITLES[gesture.edge] ?? `Swipe in from ${gesture.edge}` : gestureTitle(gesture)
}

/** The swipes a touch screen offers as rows, one per edge. */
export function edgeGestures(): EdgeGesture[] {
  return screenEdges.map((edge) => ({ edge }))
}

/**
 * The actions a row offers for this press on this frame. Voice chat
 * (docs/voice-chat.md) is a key's LONG press only: the firmware opens the
 * microphone once the key has been held for the long-press time and closes
 * it when the key is let go, so the release is what ends a sentence. A press
 * or a double press is over before the frame hears of it and has no end to
 * listen for, which is why it is not offered (a saved one is shown either way).
 */
export function frameActionKindsFor(gesture: FrameGesture, offer: FrameActionOffer): readonly FrameActionKind[] {
  const kinds: FrameActionKind[] = ['nextScene', 'prevScene']
  if (offer.backForward) {
    kinds.push('back', 'forward')
  }
  if (offer.sceneSwitcher) {
    kinds.push('sceneSwitcher')
  }
  if (offer.sceneSettings) {
    kinds.push('sceneSettings')
  }
  kinds.push('render')
  if (offer.displayPower) {
    kinds.push('turnOn', 'turnOff', 'toggleScreen')
  }
  if (offer.voiceChat && gestureCanVoiceChat(gesture)) {
    kinds.push('voiceChat')
  }
  return kinds
}

/** Why a saved action is not on offer for its row, for the label next to it; null when it is. */
export function frameActionUnavailableReason(binding: ButtonBinding, offer: FrameActionOffer): string | null {
  const kind = binding.action.kind
  if (kind === 'showScene' || frameActionKindsFor(binding.gesture, offer).includes(kind)) {
    return null
  }
  if (kind === 'voiceChat') {
    return 'long press only'
  }
  if (kind === 'turnOn' || kind === 'turnOff' || kind === 'toggleScreen') {
    return 'not on this display'
  }
  if (kind === 'sceneSwitcher') {
    return `needs FrameOS ${sceneSwitcherMinVersion}`
  }
  if (kind === 'sceneSettings') {
    return `needs FrameOS ${sceneSettingsMinVersion}`
  }
  if (kind === 'back' || kind === 'forward') {
    return `needs FrameOS ${backForwardMinVersion}`
  }
  return 'not on this frame'
}

const SHOW_SCENE_PREFIX = 'showScene:'

/** An action as one select value, and back. */
export function frameActionValue(action: FrameAction): string {
  return action.kind === 'showScene' ? `${SHOW_SCENE_PREFIX}${action.sceneId ?? ''}` : action.kind
}

export function parseFrameActionValue(value: string): FrameAction | null {
  if (value.startsWith(SHOW_SCENE_PREFIX)) {
    const sceneId = value.slice(SHOW_SCENE_PREFIX.length)
    return sceneId ? { kind: 'showScene', sceneId } : null
  }
  return (frameActionKinds as readonly string[]).includes(value) || value === 'voiceChat'
    ? { kind: value as FrameActionKind }
    : null
}

export function frameActionTitle(
  action: FrameAction,
  scenes: readonly Pick<FrameScene, 'id' | 'name'>[] = []
): string {
  if (action.kind !== 'showScene') {
    return ACTION_TITLES[action.kind]
  }
  const scene = scenes.find((candidate) => candidate.id === action.sceneId)
  return `${ACTION_TITLES.showScene}: ${scene?.name || action.sceneId || '?'}`
}

/** The rule the section writes for one binding: the press (or the swipe) replaced by the action's event. */
export function bindingRule(binding: ButtonBinding): EventMapRule {
  const gesture = binding.gesture
  const event = isEdgeGesture(gesture) ? 'edgeSwipe' : 'button'
  const match: Record<string, string> = isEdgeGesture(gesture)
    ? { edge: gesture.edge }
    : { label: gesture.label, action: gesture.action }
  switch (binding.action.kind) {
    case 'nextScene':
      return { event, match, emit: 'setCurrentScene', as: { direction: 'next' } }
    case 'prevScene':
      return { event, match, emit: 'setCurrentScene', as: { direction: 'prev' } }
    case 'showScene':
      return { event, match, emit: 'setCurrentScene', as: { sceneId: binding.action.sceneId ?? '' } }
    case 'back':
    case 'forward':
    case 'sceneSwitcher':
    case 'sceneSettings':
    case 'render':
    case 'turnOn':
    case 'turnOff':
    case 'toggleScreen':
    case 'voiceChat':
      return { event, match, emit: binding.action.kind, as: {} }
  }
}

const SCENE_LESS_EMITS: readonly string[] = [
  'back',
  'forward',
  'sceneSwitcher',
  'sceneSettings',
  'render',
  'turnOn',
  'turnOff',
  'toggleScreen',
  'voiceChat',
]

/**
 * The binding a rule means, when it is one the section writes: a `button`
 * rule matching one label and one press, or an `edgeSwipe` rule matching
 * one edge, that emits a scene switch (by direction or by id), back or
 * forward, the scene switcher, a render or a display switch with nothing
 * else in `as`.
 * Anything else is the owner's own rule and null here.
 */
export function bindingOfRule(rule: EventMapRule): ButtonBinding | null {
  const match = rule.match ?? {}
  let gesture: FrameGesture
  if (
    rule.event === 'button' &&
    typeof match.label === 'string' &&
    typeof match.action === 'string' &&
    Object.keys(match).length === 2
  ) {
    gesture = { label: match.label, action: match.action }
  } else if (
    rule.event === 'edgeSwipe' &&
    typeof match.edge === 'string' &&
    screenEdges.includes(match.edge) &&
    Object.keys(match).length === 1
  ) {
    gesture = { edge: match.edge }
  } else {
    return null
  }
  if (!rule.emit) {
    return null
  }
  const as = rule.as ?? {}
  const keys = Object.keys(as)
  if (rule.emit === 'setCurrentScene') {
    if (keys.length === 1 && (as.direction === 'next' || as.direction === 'prev')) {
      return { gesture, action: { kind: as.direction === 'next' ? 'nextScene' : 'prevScene' } }
    }
    if (keys.length === 1 && typeof as.sceneId === 'string' && as.sceneId) {
      return { gesture, action: { kind: 'showScene', sceneId: as.sceneId } }
    }
    return null
  }
  if (SCENE_LESS_EMITS.includes(rule.emit) && keys.length === 0) {
    return { gesture, action: { kind: rule.emit as FrameActionKind } }
  }
  return null
}

/** The section's rows read out of the frame's rules, and every rule it keeps as it is. */
export function frameBindings(rules: readonly EventMapRule[] | undefined): {
  bindings: ButtonBinding[]
  others: EventMapRule[]
} {
  const bindings: ButtonBinding[] = []
  const others: EventMapRule[] = []
  for (const rule of rules ?? []) {
    const binding = bindingOfRule(rule)
    if (binding) {
      bindings.push(binding)
    } else {
      others.push(rule)
    }
  }
  return { bindings, others }
}

/** The frame's rules from the section's rows: the rows first, then what it kept. */
export function frameEventMapRules(
  bindings: readonly ButtonBinding[],
  others: readonly EventMapRule[] = []
): EventMapRule[] {
  return [...bindings.map(bindingRule), ...others]
}

/**
 * The rows that will not do what they say, in the order they are listed: a
 * press bound twice (the first rule wins on the device, so the second does
 * nothing), voice chat on a press that is not a long press (nothing starts:
 * the firmware listens from the hold to the release), and a display switch
 * on a display that has none (the scene hears the event, nothing else moves).
 * The last two need the frame's offer; without one only the duplicates count.
 */
export function bindingConflicts(bindings: readonly ButtonBinding[], offer?: FrameActionOffer): string[] {
  const seen = new Map<string, number>()
  const conflicts: string[] = []
  for (const binding of bindings) {
    const key = frameGestureValue(binding.gesture)
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    const title = frameGestureTitle(binding.gesture)
    if (count === 2) {
      conflicts.push(`${title} is bound twice; only the first binding counts`)
    }
    if (binding.action.kind === 'voiceChat' && !gestureCanVoiceChat(binding.gesture)) {
      conflicts.push(
        `${title} is bound to Voice chat, which only a long press starts: the frame listens while the key is held and stops when it is let go, so this press does nothing`
      )
    } else if (
      offer &&
      !offer.displayPower &&
      (binding.action.kind === 'turnOn' || binding.action.kind === 'turnOff' || binding.action.kind === 'toggleScreen')
    ) {
      conflicts.push(
        `${title} is bound to ${ACTION_TITLES[binding.action.kind]}, but this display cannot be switched off and on; only the scene hears it`
      )
    }
  }
  return conflicts
}

/**
 * What the device says its map is (`hardware.eventMap`): the shape is the
 * device's, so a malformed entry drops rather than renders. Null where the
 * report has none (older firmware).
 */
export function reportedEventMapOf(value: unknown): EventMapRule[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value.filter(isEventMapRule)
}

/** Whether a frame's rows offer the swipes in from its edges: a touch screen, or a map that binds one already. */
export function frameOffersEdgeGestures(
  touch: boolean | null | undefined,
  device: string | null | undefined,
  rules: readonly EventMapRule[] | undefined
): boolean {
  return (
    touch === true ||
    deviceEventMap(device) !== null ||
    device === 'lcd.st7701s_480x480' ||
    (rules ?? []).some((rule) => rule.event === 'edgeSwipe')
  )
}

/** The event map a device comes with, which a frame never given one (no
 * stored `event_map`) runs with: a HyperPixel's edge swipes, in from the left
 * `back`, in from the right `forward`, up from the bottom the scene switcher
 * and down from the top the scene's settings. Keep in step
 * with frameos/src/frameos/device_event_map.nim
 * (device-event-map.test.ts reads it). null for a device that comes with none. */
export function deviceEventMap(device: string | null | undefined): EventMapRule[] | null {
  if (!device?.startsWith('pimoroni.hyperpixel')) {
    return null
  }
  return [
    { event: 'edgeSwipe', match: { edge: 'right' }, emit: 'forward', as: {} },
    { event: 'edgeSwipe', match: { edge: 'left' }, emit: 'back', as: {} },
    { event: 'edgeSwipe', match: { edge: 'bottom' }, emit: 'sceneSwitcher', as: {} },
    { event: 'edgeSwipe', match: { edge: 'top' }, emit: 'sceneSettings', as: {} },
  ]
}
