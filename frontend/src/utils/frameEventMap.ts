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

/** The actions a row may pick, scene-less first; `showScene` needs a scene. */
export const frameActionKinds: readonly FrameActionKind[] = ['nextScene', 'prevScene', 'render', 'turnOn', 'turnOff']

/**
 * Voice chat (docs/voice-chat.md) is an action of a key's LONG press only,
 * on a frame with a microphone: the firmware opens the microphone while the
 * key is held and closes it at the release, so no other press can carry it.
 * The section offers it for those rows when the frame has voice chat at all
 * (`useFrameSettings().voiceChat`, ESP32 only), and shows a saved one either way.
 */
export function frameActionKindsFor(gesture: ButtonGesture, voiceChat: boolean): readonly FrameActionKind[] {
  return voiceChat && gesture.action === 'longPress' ? [...frameActionKinds, 'voiceChat'] : frameActionKinds
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

/** The presses bound twice: the first rule wins on the device, so the second does nothing. */
export function bindingConflicts(bindings: readonly ButtonBinding[]): string[] {
  const seen = new Map<string, number>()
  const conflicts: string[] = []
  for (const binding of bindings) {
    const key = `${binding.gesture.label}\u0000${binding.gesture.action}`
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count === 2) {
      conflicts.push(`${gestureTitle(binding.gesture)} is bound twice; only the first binding counts`)
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
