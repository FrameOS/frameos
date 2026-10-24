// The frame's event map (docs/events.md, "Event map") as the Settings panel's
// "Button actions" sees it.
//
// A frame's buttons do something whatever scene is showing: a reTerminal's
// LEFT held is the previous scene, RIGHT held the next, on every preset. The
// map is frame.json `eventMap` (`event_map` on the wire), a list of rules the
// device's dispatcher applies before any scene is asked; a rule with `emit`
// replaces the press with the event it names and the scene never hears it.
// This module turns the rules into the section's rows — one press of one
// button, one action — and the rows back into rules; rules the section did
// not write (hand-made, a rewrite, another event) are kept as they are.
//
// Import-light on purpose (types, the contract tables, the scene map helpers):
// the cloud's node test suite exercises it directly.
import type { EventMapRule, FrameScene } from '../types'
import { isEventMapRule } from './cloudFrameSettings'
import { type ButtonGesture, gestureTitle } from './sceneEventMap'

export type FrameActionKind = 'nextScene' | 'prevScene' | 'showScene' | 'render' | 'turnOn' | 'turnOff' | 'voiceChat'

/** What a bound press does. `sceneId` for `showScene` alone. */
export interface FrameAction {
  kind: FrameActionKind
  sceneId?: string
}

/** One row of the section: a press of one of the frame's buttons, and its action. */
export interface ButtonBinding {
  gesture: ButtonGesture
  action: FrameAction
}

const ACTION_TITLES: Record<FrameActionKind, string> = {
  nextScene: 'Next scene',
  prevScene: 'Previous scene',
  showScene: 'Show scene',
  render: 'Refresh',
  turnOn: 'Display on',
  turnOff: 'Display off',
  voiceChat: 'Voice chat',
}

/** Every scene-less action a rule can mean; `showScene` needs a scene. What a given frame offers is `frameActionKindsFor`. */
export const frameActionKinds: readonly FrameActionKind[] = ['nextScene', 'prevScene', 'render', 'turnOn', 'turnOff']

/** What this frame can do with a press, as far as the actions on offer go. */
export interface FrameActionOffer {
  /** The frame has voice chat at all (`useFrameSettings().voiceChat`: a microphone, ESP32 only). */
  voiceChat: boolean
  /**
   * The display's driver can power the panel down and back up
   * (`deviceSupportsDisplayPower`): the framebuffer and the HyperPixels. On
   * e-paper and on every ESP32 board `turnOn` / `turnOff` switch nothing
   * (docs/events.md, the host table), so the row does not offer them there.
   */
  displayPower: boolean
}

/** Whether a press can carry voice chat: a long press alone. */
export function gestureCanVoiceChat(gesture: ButtonGesture): boolean {
  return gesture.action === 'longPress'
}

/**
 * The actions a row offers for this press on this frame. Voice chat
 * (docs/voice-chat.md) is a key's LONG press only: the firmware opens the
 * microphone once the key has been held for the long-press time and closes
 * it when the key is let go, so the release is what ends a sentence. A press
 * or a double press is over before the frame hears of it and has no end to
 * listen for, which is why it is not offered (a saved one is shown either way).
 */
export function frameActionKindsFor(gesture: ButtonGesture, offer: FrameActionOffer): readonly FrameActionKind[] {
  const kinds: FrameActionKind[] = ['nextScene', 'prevScene', 'render']
  if (offer.displayPower) {
    kinds.push('turnOn', 'turnOff')
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
  if (kind === 'turnOn' || kind === 'turnOff') {
    return 'not on this display'
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

/** The rule the section writes for one binding: the press replaced by the action's event. */
export function bindingRule(binding: ButtonBinding): EventMapRule {
  const match = { label: binding.gesture.label, action: binding.gesture.action }
  switch (binding.action.kind) {
    case 'nextScene':
      return { event: 'button', match, emit: 'setCurrentScene', as: { direction: 'next' } }
    case 'prevScene':
      return { event: 'button', match, emit: 'setCurrentScene', as: { direction: 'prev' } }
    case 'showScene':
      return { event: 'button', match, emit: 'setCurrentScene', as: { sceneId: binding.action.sceneId ?? '' } }
    case 'render':
    case 'turnOn':
    case 'turnOff':
    case 'voiceChat':
      return { event: 'button', match, emit: binding.action.kind, as: {} }
  }
}

/**
 * The binding a rule means, when it is one the section writes: a `button`
 * rule matching one label and one press that emits a scene switch (by
 * direction or by id), a render or a display switch with nothing else in
 * `as`. Anything else is the owner's own rule and null here.
 */
export function bindingOfRule(rule: EventMapRule): ButtonBinding | null {
  const match = rule.match ?? {}
  if (
    rule.event !== 'button' ||
    typeof match.label !== 'string' ||
    typeof match.action !== 'string' ||
    Object.keys(match).length !== 2 ||
    !rule.emit
  ) {
    return null
  }
  const gesture: ButtonGesture = { label: match.label, action: match.action }
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
  if (
    (rule.emit === 'render' || rule.emit === 'turnOn' || rule.emit === 'turnOff' || rule.emit === 'voiceChat') &&
    keys.length === 0
  ) {
    return { gesture, action: { kind: rule.emit } }
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
    const key = `${binding.gesture.label}\u0000${binding.gesture.action}`
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count === 2) {
      conflicts.push(`${gestureTitle(binding.gesture)} is bound twice; only the first binding counts`)
    }
    if (binding.action.kind === 'voiceChat' && !gestureCanVoiceChat(binding.gesture)) {
      conflicts.push(
        `${gestureTitle(binding.gesture)} is bound to Voice chat, which only a long press starts: the frame listens while the key is held and stops when it is let go, so this press does nothing`
      )
    } else if (offer && !offer.displayPower && (binding.action.kind === 'turnOn' || binding.action.kind === 'turnOff')) {
      conflicts.push(
        `${gestureTitle(binding.gesture)} is bound to ${ACTION_TITLES[binding.action.kind]}, but this display cannot be switched off and on; only the scene hears it`
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
