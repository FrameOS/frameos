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
// bottom the scene switcher (docs/scene-switcher.md). A frame with an
// accelerometer (docs/accelerometer.md) binds its motion the same way: a
// `flick` or a `tilt` toward one side, a `shake`, an `orientation` it comes to
// rest in (laid face down) — a flick right as Forward turns a reader's page.
// None is bound by default: a motion rule of the frame's map takes that
// gesture from every scene (a tilting game included), so a scene's own
// "Map buttons" is the place for one scene's.
// This module turns the rules into the section's rows — one press of one
// button or one edge, one action — and the rows back into rules; rules the
// section did not write (hand-made, a rewrite, another event) are kept as
// they are.
//
// Import-light on purpose (types, the contract tables, the scene map helpers, showIf's coercion):
// the cloud's node test suite exercises it directly.
import type { EventMapRule, FrameScene, StateField } from '../types'
import { HYPERPIXEL_EVENT_MAP, INKY_IMPRESSION_DEVICES, INKY_IMPRESSION_EVENT_MAP } from '../generated/boardKeys.gen'
import { cloudFrameSupportsSettingsFrom, isEventMapRule } from './cloudFrameSettings'
import { buttonTriplePressSince, contractEventSpecs, screenEdges } from './eventsContract.gen'
import { actionTitle, type ButtonGesture, gestureTitle, gestureValue, parseGestureValue } from './sceneEventMap'
import { coerceStateFieldValue } from './showIf'

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

/** A scene's settings a press shows it with: its public fields' values (`setCurrentScene`'s `state`). */
export type ShowSceneState = Record<string, unknown>

/**
 * What a bound press does. `sceneId` for `showScene` alone, and with it
 * `state`: the values of that scene's public fields the press shows it with
 * (absent or empty: the scene as it is).
 */
export interface FrameAction {
  kind: FrameActionKind
  sceneId?: string
  state?: ShowSceneState
}

/** A swipe in from one edge of a touch screen (the dispatcher's `edgeSwipe`). */
export interface EdgeGesture {
  edge: string
}

/** A motion of the frame itself, read by its accelerometer (docs/accelerometer.md): a
 * `flick` or a `tilt` toward one side of the picture, a `shake`, or an `orientation` it
 * came to rest in. `direction` for the first two, `position` for the last. */
export interface MotionGesture {
  event: MotionEvent
  direction?: string
  position?: string
}

export type MotionEvent = 'flick' | 'tilt' | 'shake' | 'orientation'

/** The contract's `gestures.directions` (a flick's and a tilt's `direction`). */
export const motionDirections: readonly string[] = ['left', 'right', 'up', 'down']
/** The contract's `motion.positions` (an `orientation`'s `position`). */
export const motionPositions: readonly string[] = [
  'upright',
  'turnedLeft',
  'turnedRight',
  'upsideDown',
  'faceUp',
  'faceDown',
]

const MOTION_DIRECTION_TITLES: Record<string, string> = {
  left: 'to the left',
  right: 'to the right',
  up: 'up',
  down: 'down',
}

const MOTION_POSITION_TITLES: Record<string, string> = {
  upright: 'Stood upright',
  turnedLeft: 'Turned onto its left side',
  turnedRight: 'Turned onto its right side',
  upsideDown: 'Turned upside down',
  faceUp: 'Laid face up',
  faceDown: 'Laid face down',
}

/** A press of whichever key plays a role (docs/buttons.md): the arrows held,
 * which turn with the frame, and Back, which two keys held together are on a
 * board with no Back key. A hardware preset's map binds these by role. */
export interface RoleGesture {
  role: string
  action: string
}

/** What a row binds: a press of one of the frame's buttons, of a key by its role, a swipe in from an edge, or a motion of the frame. */
export type FrameGesture = ButtonGesture | EdgeGesture | RoleGesture | MotionGesture

const ROLE_TITLES: Record<string, string> = {
  next: 'Next key',
  prev: 'Previous key',
  back: 'Back key (two keys together where there is none)',
  primary: 'Action key',
  menu: 'Home key',
  screen: 'Screen key',
}

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

/** The first FrameOS that hears its accelerometer (the contract's `flick.since`). */
export const motionGesturesMinVersion: string = contractEventSpecs.flick.since ?? '0.0.0'

/** Whether a frame on this FrameOS makes the motion events, as `frameSupportsSceneSwitcher`. */
export function frameSupportsMotionGestures(frameosVersion: string | null | undefined, cloud: boolean): boolean {
  if (!cloud && (typeof frameosVersion !== 'string' || frameosVersion.trim().length === 0)) {
    return true
  }
  return cloudFrameSupportsSettingsFrom(motionGesturesMinVersion, frameosVersion)
}

/** The first FrameOS that makes a `triplePress` (the contract's `buttons.triplePressSince`). */
export const triplePressMinVersion: string = buttonTriplePressSince

/**
 * Whether a frame on this FrameOS makes a triple press, so a row may bind
 * one, as `frameSupportsSceneSwitcher`. The cloud refuses a map with one for
 * an older frame (`settings_need_newer_firmware`).
 */
export function frameSupportsTriplePress(frameosVersion: string | null | undefined, cloud: boolean): boolean {
  if (!cloud && (typeof frameosVersion !== 'string' || frameosVersion.trim().length === 0)) {
    return true
  }
  return cloudFrameSupportsSettingsFrom(triplePressMinVersion, frameosVersion)
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

export function isRoleGesture(gesture: FrameGesture): gesture is RoleGesture {
  return 'role' in gesture && !('label' in gesture)
}

export function isMotionGesture(gesture: FrameGesture): gesture is MotionGesture {
  return 'event' in gesture
}

/** A motion gesture, when this is one the rows write: a known event with its one known value. */
export function motionGesture(event: unknown, value?: unknown): MotionGesture | null {
  if ((event === 'flick' || event === 'tilt') && typeof value === 'string' && motionDirections.includes(value)) {
    return { event, direction: value }
  }
  if (event === 'orientation' && typeof value === 'string' && motionPositions.includes(value)) {
    return { event, position: value }
  }
  return event === 'shake' && value === undefined ? { event } : null
}

/** What a motion rule matches: the direction, the position, or nothing (any shake). */
function motionMatch(gesture: MotionGesture): Record<string, string> | undefined {
  if (gesture.event === 'shake') {
    return undefined
  }
  return gesture.event === 'orientation' ? { position: gesture.position ?? '' } : { direction: gesture.direction ?? '' }
}

/** The motion a rule's `event` and `match` say, when it is one the rows write. */
export function motionGestureOfRule(rule: Pick<EventMapRule, 'event' | 'match'>): MotionGesture | null {
  const match = rule.match ?? {}
  const keys = Object.keys(match)
  if (rule.event === 'shake') {
    return keys.length === 0 ? { event: 'shake' } : null
  }
  if (keys.length !== 1) {
    return null
  }
  return motionGesture(rule.event, rule.event === 'orientation' ? match.position : match.direction)
}

/** What a motion row says: "Flick to the right", "Shake", "Laid face down". */
export function motionGestureTitle(gesture: MotionGesture): string {
  switch (gesture.event) {
    case 'flick':
      return `Flick ${MOTION_DIRECTION_TITLES[gesture.direction ?? ''] ?? gesture.direction}`
    case 'tilt':
      return `Tilt ${MOTION_DIRECTION_TITLES[gesture.direction ?? ''] ?? gesture.direction} and hold`
    case 'shake':
      return 'Shake'
    case 'orientation':
      return MOTION_POSITION_TITLES[gesture.position ?? ''] ?? `Turned ${gesture.position}`
  }
}

/** The motions a frame with an accelerometer offers as rows: flicks, tilts, a shake, the positions. */
export function motionGestures(): MotionGesture[] {
  return [
    ...motionDirections.map((direction): MotionGesture => ({ event: 'flick', direction })),
    ...motionDirections.map((direction): MotionGesture => ({ event: 'tilt', direction })),
    { event: 'shake' },
    ...motionPositions.map((position): MotionGesture => ({ event: 'orientation', position })),
  ]
}

/** Whether a press can carry voice chat: a key's long press alone, by its
 * label (the firmware finds its voice key by label, docs/voice-chat.md). */
export function gestureCanVoiceChat(gesture: FrameGesture): boolean {
  return (
    !isEdgeGesture(gesture) && !isRoleGesture(gesture) && !isMotionGesture(gesture) && gesture.action === 'longPress'
  )
}

/** A row's press or swipe as one select value, and back. */
export function frameGestureValue(gesture: FrameGesture): string {
  if (isEdgeGesture(gesture)) {
    return JSON.stringify({ edge: gesture.edge })
  }
  if (isRoleGesture(gesture)) {
    return JSON.stringify({ role: gesture.role, action: gesture.action })
  }
  if (isMotionGesture(gesture)) {
    return JSON.stringify({ event: gesture.event, ...motionMatch(gesture) })
  }
  return gestureValue(gesture)
}

export function parseFrameGestureValue(value: string): FrameGesture | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const { edge, role, action, event, direction, position } = parsed as Record<string, unknown>
      if (typeof event === 'string') {
        return motionGesture(event, event === 'orientation' ? position : direction)
      }
      if (typeof role === 'string' && typeof action === 'string') {
        return { role, action }
      }
      return typeof edge === 'string' && screenEdges.includes(edge) ? { edge } : null
    }
  } catch {
    return null
  }
  return parseGestureValue(value)
}

export function frameGestureTitle(gesture: FrameGesture): string {
  if (isEdgeGesture(gesture)) {
    return EDGE_TITLES[gesture.edge] ?? `Swipe in from ${gesture.edge}`
  }
  if (isRoleGesture(gesture)) {
    return `${ROLE_TITLES[gesture.role] ?? `${gesture.role} key`} · ${actionTitle(gesture.action)}`
  }
  if (isMotionGesture(gesture)) {
    return motionGestureTitle(gesture)
  }
  return gestureTitle(gesture)
}

/** The keys a frame's map binds by role (docs/buttons.md), offered as rows:
 * the arrows held, which turn with the frame, and Back pressed and held,
 * which two keys held together are on a board with no Back key. */
export function roleGestures(): RoleGesture[] {
  return [
    { role: 'next', action: 'longPress' },
    { role: 'prev', action: 'longPress' },
    { role: 'back', action: 'press' },
    { role: 'back', action: 'longPress' },
  ]
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

export function frameActionTitle(action: FrameAction, scenes: readonly Pick<FrameScene, 'id' | 'name'>[] = []): string {
  if (action.kind !== 'showScene') {
    return ACTION_TITLES[action.kind]
  }
  const scene = scenes.find((candidate) => candidate.id === action.sceneId)
  const settings = Object.keys(action.state ?? {}).length
  const suffix = settings === 0 ? '' : settings === 1 ? ' (1 setting)' : ` (${settings} settings)`
  return `${ACTION_TITLES.showScene}: ${scene?.name || action.sceneId || '?'}${suffix}`
}

/**
 * A Show scene action with one of its scene's settings set, or taken out
 * (`value` undefined or null: the scene keeps its own). The value is stored
 * as the field's type wants it (`coerceStateFieldValue`: a boolean as a
 * boolean, a number as a number; a number that does not parse is taken out),
 * as the scene's settings form saves it.
 */
export function withShowSceneSetting(
  action: FrameAction,
  field: Pick<StateField, 'name' | 'type'>,
  value: unknown
): FrameAction {
  const { [field.name]: _previous, ...rest } = action.state ?? {}
  const coerced =
    (field.type === 'integer' || field.type === 'float') && value === ''
      ? undefined
      : coerceStateFieldValue(field, value)
  const state = coerced === undefined || coerced === null ? rest : { ...rest, [field.name]: coerced }
  const { state: _state, ...plain } = action
  return Object.keys(state).length > 0 ? { ...plain, state } : plain
}

/**
 * The settings of a Show scene action its scene no longer has as public
 * fields (renamed, made private, removed): the frame ignores them, and the
 * row names them so they can be cleared.
 */
export function showSceneStaleSettings(action: FrameAction, fieldNames: readonly string[]): string[] {
  return Object.keys(action.state ?? {}).filter((name) => !fieldNames.includes(name))
}

/** The rule the section writes for one binding: the press (or the swipe) replaced by the action's event. */
export function bindingRule(binding: ButtonBinding): EventMapRule {
  const gesture = binding.gesture
  const event = isEdgeGesture(gesture) ? 'edgeSwipe' : isMotionGesture(gesture) ? gesture.event : 'button'
  const match: Record<string, string> | undefined = isEdgeGesture(gesture)
    ? { edge: gesture.edge }
    : isRoleGesture(gesture)
      ? { role: gesture.role, action: gesture.action }
      : isMotionGesture(gesture)
        ? motionMatch(gesture)
        : { label: gesture.label, action: gesture.action }
  // A shake matches any shake: the rule has no `match`.
  const on = match ? { event, match } : { event }
  switch (binding.action.kind) {
    case 'nextScene':
      return { ...on, emit: 'setCurrentScene', as: { direction: 'next' } }
    case 'prevScene':
      return { ...on, emit: 'setCurrentScene', as: { direction: 'prev' } }
    case 'showScene':
      return {
        ...on,
        emit: 'setCurrentScene',
        as:
          binding.action.state && Object.keys(binding.action.state).length > 0
            ? { sceneId: binding.action.sceneId ?? '', state: { ...binding.action.state } }
            : { sceneId: binding.action.sceneId ?? '' },
      }
    case 'back':
    case 'forward':
    case 'sceneSwitcher':
    case 'sceneSettings':
    case 'render':
    case 'turnOn':
    case 'turnOff':
    case 'toggleScreen':
    case 'voiceChat':
      return { ...on, emit: binding.action.kind, as: {} }
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
 * rule matching one label (or one role) and one press, or an `edgeSwipe` rule matching
 * one edge, or a motion rule (`motionGestureOfRule`), that emits a scene switch (by direction, or by id with the
 * scene's settings to show it with), back or
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
    rule.event === 'button' &&
    typeof match.role === 'string' &&
    typeof match.action === 'string' &&
    Object.keys(match).length === 2
  ) {
    gesture = { role: match.role, action: match.action }
  } else if (
    rule.event === 'edgeSwipe' &&
    typeof match.edge === 'string' &&
    screenEdges.includes(match.edge) &&
    Object.keys(match).length === 1
  ) {
    gesture = { edge: match.edge }
  } else {
    const motion = motionGestureOfRule(rule)
    if (!motion) {
      return null
    }
    gesture = motion
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
    // A scene by id, and the values of its public fields the press shows it
    // with (`state`, a plain object; an empty one is no settings).
    const state: unknown = as.state
    if (
      typeof as.sceneId === 'string' &&
      as.sceneId &&
      keys.every((key) => key === 'sceneId' || key === 'state') &&
      (state === undefined || (typeof state === 'object' && state !== null && !Array.isArray(state)))
    ) {
      const settings = (state ?? {}) as ShowSceneState
      return {
        gesture,
        action:
          Object.keys(settings).length > 0
            ? { kind: 'showScene', sceneId: as.sceneId, state: { ...settings } }
            : { kind: 'showScene', sceneId: as.sceneId },
      }
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

/**
 * An installed scene's motion rows ("Map buttons", docs/accelerometer.md): its
 * rules that bind a motion of the frame to an action, written as the frame's
 * rows are (`bindingRule`), and every other rule. A scene's map applies only
 * while that scene shows, so a reader can turn its pages with a flick
 * (Forward, Back) and a tilting game keep its tilts.
 */
export function sceneMotionBindings(rules: readonly EventMapRule[] | undefined): {
  bindings: ButtonBinding[]
  others: EventMapRule[]
} {
  const bindings: ButtonBinding[] = []
  const others: EventMapRule[] = []
  for (const rule of rules ?? []) {
    const binding = bindingOfRule(rule)
    if (binding && isMotionGesture(binding.gesture)) {
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
        `${title} is bound to ${
          ACTION_TITLES[binding.action.kind]
        }, but this display cannot be switched off and on; only the scene hears it`
      )
    }
  }
  return conflicts
}

/**
 * The most an ESP32 holds of its frame's event map: the compact JSON in a
 * 1 KB slot with its terminating NUL (`FOS_EVENT_MAP_LEN`,
 * embedded/esp32/main/fos_config.h). A longer map is refused by the cloud's
 * frame and ignored by a backend's (`settings: eventMap ignored`), so the
 * section says so before it is saved. A Show scene's settings are what makes
 * a map long.
 */
export const esp32EventMapMaxBytes = 1023

/** The bytes the frame's map takes on an ESP32 (compact JSON, UTF-8). */
export function eventMapBytes(rules: readonly EventMapRule[]): number {
  return rules.length === 0 ? 0 : new TextEncoder().encode(JSON.stringify(rules)).length
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
    device === 'lcd.ek9716_800x480' ||
    device === 'lcd.sc7277_800x480' ||
    device === 'amoled.co5300_466x466' ||
    device === 'lcd.gc9309_240x296' ||
    device === 'lcd.st77961_360x360' ||
    device === 'lcd.st7789_320x240' ||
    (rules ?? []).some((rule) => rule.event === 'edgeSwipe')
  )
}

/** The event map a device comes with, which a frame never given one (no
 * stored `event_map`) runs with: a HyperPixel's edge swipes, in from the left
 * `back`, in from the right `forward`, up from the bottom the scene switcher
 * and down from the top the scene's settings; an Inky Impression's A to D
 * (docs/buttons.md). Generated with frameos/src/frameos/device_event_map.nim's
 * (frameos/tools/generate_board_keys.py; device-event-map.test.ts reads both).
 * null for a device that comes with none. */
export function deviceEventMap(device: string | null | undefined): EventMapRule[] | null {
  if (device?.startsWith('pimoroni.hyperpixel')) {
    return JSON.parse(JSON.stringify(HYPERPIXEL_EVENT_MAP))
  }
  if (device && INKY_IMPRESSION_DEVICES.includes(device)) {
    return JSON.parse(JSON.stringify(INKY_IMPRESSION_EVENT_MAP))
  }
  return null
}
