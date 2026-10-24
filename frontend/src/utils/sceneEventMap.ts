// The event map of an installed scene (docs/events.md, "Event map") as the
// "Map buttons" dialog sees it.
//
// A frame has the keys it has (LEFT, RIGHT, REFRESH) and a scene listens for
// the ones its author had (`label: "A"`, `role: "next"`). The map is a list
// of rules on the INSTALLED scene — `eventMap` beside `nodes`, never inside
// them, so a scene update keeps it — and the device's dispatcher applies it
// before the scene is asked. This module turns the scene's `button` listeners
// and the frame's buttons into the dialog's rows and choices, and the choices
// back into rules; rules the dialog did not write (hand-made, or for another
// event) are kept as they are.
//
// Import-light on purpose (types, the contract tables and one device table):
// the cloud's node test suite exercises it directly.
import type { EventMapRule, EventMapValue, FrameScene, FrameType, GPIOButton } from '../types'
import { buttonActions, buttonRoleByLabel } from './eventsContract.gen'
import { configuredGpioButtonsForDevice } from './deviceGpioButtons'

/** One `button` listener of the scene, by what it filters on. */
export interface ButtonListener {
  /** The filter signature: one row per distinct set of filters. */
  key: string
  /** The key the listener names: its label, its role, its pin (as text). */
  identity: { label?: string; role?: string; pin?: string }
  /** The press it filters on, when it does (`press`, `doublePress`, `longPress`). */
  action?: string
  /** What the row says: "A", "next (role)", "A · long press". */
  title: string
}

/** One press of one of the frame's buttons: what a listener can be mapped to. */
export interface ButtonGesture {
  label: string
  action: string
}

const ACTION_TITLES: Record<string, string> = {
  press: 'press',
  doublePress: 'double press',
  longPress: 'long press',
}

export function actionTitle(action: string): string {
  return ACTION_TITLES[action] ?? action
}

/** The default role of a label (`buttons.roleByLabel`), or ''. */
export function defaultButtonRole(label: string): string {
  return buttonRoleByLabel[label.trim().toUpperCase()] ?? ''
}

/**
 * The frame's buttons with their effective role: the ones its device always
 * has (an Inky's A–D), then the configured list (the form's, else the
 * frame's), else what the device reported (`hardware.gpioButtons`). One row
 * per pin, the first wins; the role is the configured one, else the
 * contract's default for the label.
 */
export function frameButtons(
  frame: Partial<FrameType> | null | undefined,
  frameForm?: Partial<FrameType> | null
): GPIOButton[] {
  const fixed = configuredGpioButtonsForDevice(frame?.device) ?? []
  const own = frameForm?.gpio_buttons ?? frame?.gpio_buttons
  const reported = own ? [] : frame?.hardware?.gpioButtons ?? []
  const result: GPIOButton[] = []
  const seenPins = new Set<number>()
  const seenLabels = new Set<string>()
  for (const button of [...fixed, ...(own ?? []), ...reported]) {
    const label = typeof button?.label === 'string' ? button.label.trim() : ''
    if (!label || seenLabels.has(label) || (typeof button.pin === 'number' && seenPins.has(button.pin))) {
      continue
    }
    seenLabels.add(label)
    if (typeof button.pin === 'number') {
      seenPins.add(button.pin)
    }
    result.push({ pin: button.pin, label, role: (button as GPIOButton).role || defaultButtonRole(label) })
  }
  return result
}

function filterText(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  return String(value).trim()
}

function listenerTitle(identity: ButtonListener['identity'], action?: string): string {
  const parts: string[] = []
  if (identity.label) {
    parts.push(identity.label)
  }
  if (identity.role) {
    parts.push(identity.label ? `role ${identity.role}` : `${identity.role} (role)`)
  }
  if (identity.pin) {
    parts.push(`pin ${identity.pin}`)
  }
  const who = parts.join(', ')
  return action ? `${who} · ${actionTitle(action)}` : who
}

/**
 * The scene's `button` listeners that name a key (a label, a role or a pin):
 * the rows of the dialog. A listener with no such filter hears every button
 * and needs no map; one per distinct filter set.
 */
export function sceneButtonListeners(scene: Pick<FrameScene, 'nodes'> | null | undefined): ButtonListener[] {
  const listeners: ButtonListener[] = []
  const seen = new Set<string>()
  for (const node of scene?.nodes ?? []) {
    if (node?.type !== 'event') {
      continue
    }
    const data = (node.data ?? {}) as { keyword?: unknown; config?: Record<string, unknown>; label?: unknown }
    if (data.keyword !== 'button') {
      continue
    }
    const config = data.config && typeof data.config === 'object' ? data.config : {}
    const identity: ButtonListener['identity'] = {}
    // Old scenes filter on `data.label`; `config.label` wins when both are set
    // (EventNode writes both).
    const label = filterText(config.label) || filterText(data.label)
    const role = filterText(config.role)
    const pin = filterText(config.pin)
    if (label) {
      identity.label = label
    }
    if (role) {
      identity.role = role
    }
    if (pin) {
      identity.pin = pin
    }
    if (!label && !role && !pin) {
      continue
    }
    const action = filterText(config.action) || undefined
    const key = JSON.stringify([identity.label ?? '', identity.role ?? '', identity.pin ?? '', action ?? ''])
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    listeners.push({ key, identity, ...(action ? { action } : {}), title: listenerTitle(identity, action) })
  }
  return listeners
}

/** The frame's buttons a listener hears without any map (by label, role and pin). */
export function buttonsHeardAsIs(listener: ButtonListener, buttons: readonly GPIOButton[]): GPIOButton[] {
  return buttons.filter(
    (button) =>
      (!listener.identity.label || listener.identity.label === button.label) &&
      (!listener.identity.role || listener.identity.role === (button.role || defaultButtonRole(button.label))) &&
      (!listener.identity.pin || listener.identity.pin === String(button.pin))
  )
}

/** Every press of every button, in button order: the dialog's choices. */
export function buttonGestures(buttons: readonly GPIOButton[]): ButtonGesture[] {
  const gestures: ButtonGesture[] = []
  for (const button of buttons) {
    for (const action of buttonActions) {
      gestures.push({ label: button.label, action })
    }
  }
  return gestures
}

/** A gesture as one select value, and back. */
export function gestureValue(gesture: ButtonGesture): string {
  return JSON.stringify([gesture.label, gesture.action])
}

export function parseGestureValue(value: string): ButtonGesture | null {
  if (!value) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { label: parsed[0], action: parsed[1] }
    }
  } catch {
    // not a gesture
  }
  return null
}

export function gestureTitle(gesture: ButtonGesture): string {
  return `${gesture.label} · ${actionTitle(gesture.action)}`
}

/** What a rule for this listener writes over the payload: every field the listener filters on. */
function listenerAs(listener: ButtonListener): Record<string, EventMapValue> {
  const as: Record<string, EventMapValue> = {}
  if (listener.identity.label) {
    as.label = listener.identity.label
  }
  if (listener.identity.role) {
    as.role = listener.identity.role
  }
  if (listener.identity.pin) {
    as.pin = /^-?\d+$/.test(listener.identity.pin) ? Number(listener.identity.pin) : listener.identity.pin
  }
  if (listener.action) {
    as.action = listener.action
  }
  return as
}

function sameValues(a: Record<string, EventMapValue> | undefined, b: Record<string, EventMapValue>): boolean {
  const left = a ?? {}
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(b).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && String(left[key]) === String(b[key]))
  )
}

/** The rule the dialog writes for one listener mapped to one gesture. */
export function buttonMapRule(listener: ButtonListener, gesture: ButtonGesture): EventMapRule {
  return {
    event: 'button',
    match: { label: gesture.label, action: gesture.action },
    as: listenerAs(listener),
  }
}

/**
 * The dialog's state read out of an installed scene's rules: per listener the
 * gesture its rule maps (the first rule that writes exactly what the listener
 * filters on), and every other rule, which the dialog keeps untouched.
 */
export function buttonMapChoices(
  rules: readonly EventMapRule[] | undefined,
  listeners: readonly ButtonListener[]
): { choices: Record<string, string>; custom: EventMapRule[] } {
  const choices: Record<string, string> = {}
  const custom: EventMapRule[] = []
  for (const rule of rules ?? []) {
    const match = rule.match ?? {}
    const gesture: ButtonGesture | null =
      rule.event === 'button' &&
      typeof match.label === 'string' &&
      typeof match.action === 'string' &&
      Object.keys(match).length === 2
        ? { label: match.label, action: match.action }
        : null
    // A rule that emits is not a remap of a listener: the dialog keeps it.
    const listener =
      gesture && !rule.emit
        ? listeners.find((candidate) => !choices[candidate.key] && sameValues(rule.as, listenerAs(candidate)))
        : undefined
    if (gesture && listener) {
      choices[listener.key] = gestureValue(gesture)
    } else {
      custom.push(rule)
    }
  }
  return { choices, custom }
}

/** The installed scene's rules from the dialog's state: the dialog's first, then what it kept. */
export function buttonMapRules(
  listeners: readonly ButtonListener[],
  choices: Record<string, string>,
  custom: readonly EventMapRule[] = []
): EventMapRule[] {
  const rules: EventMapRule[] = []
  for (const listener of listeners) {
    const gesture = parseGestureValue(choices[listener.key] ?? '')
    if (gesture) {
      rules.push(buttonMapRule(listener, gesture))
    }
  }
  return [...rules, ...custom]
}

/** The listeners that chose the same gesture: a press can only mean one thing. */
export function buttonMapConflicts(listeners: readonly ButtonListener[], choices: Record<string, string>): string[] {
  const byGesture = new Map<string, ButtonListener[]>()
  for (const listener of listeners) {
    const value = choices[listener.key]
    if (value) {
      byGesture.set(value, [...(byGesture.get(value) ?? []), listener])
    }
  }
  const conflicts: string[] = []
  for (const [value, chosen] of byGesture) {
    if (chosen.length > 1) {
      const gesture = parseGestureValue(value)
      conflicts.push(
        `${gesture ? gestureTitle(gesture) : value} is mapped to ${chosen
          .map((listener) => listener.title)
          .join(' and ')}`
      )
    }
  }
  return conflicts
}

/** The scene with `eventMap` set to the rules, or without the key when there are none. */
export function withSceneEventMap<T extends Partial<FrameScene>>(scene: T, rules: readonly EventMapRule[]): T {
  const { eventMap: _dropped, ...rest } = scene as T & { eventMap?: unknown }
  return (rules.length > 0 ? { ...rest, eventMap: [...rules] } : rest) as T
}

/** The scene without the installed copy's map: what a template, a zip or a store version carries. */
export function withoutSceneEventMap<T extends Partial<FrameScene>>(scene: T): T {
  if (!scene || !('eventMap' in scene)) {
    return scene
  }
  const { eventMap: _dropped, ...rest } = scene as T & { eventMap?: unknown }
  return rest as T
}
