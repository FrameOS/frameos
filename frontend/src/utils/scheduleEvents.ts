// What a schedule entry can do, shared by the Schedule panel, the workspace
// cards and the dashboard so a non-scene entry never renders as "Unknown
// scene". Deliberately free of the types barrel: the shape below is the
// subset of ScheduledEvent these helpers need.
//
// Which events the panel offers, under which label, is the event contract's
// `schedule` block (docs/events-contract.json): `setCurrentScene` is handled
// by the runner, `restart` exits the runtime (systemd brings it back),
// `reboot` runs the device's privileged reboot. On the ESP32 the last two are
// the same esp_restart(). What a device *accepts* from a schedule is wider —
// every event whose `origins` list "schedule" — so this is still a UI list,
// only no longer a second one.
//
// A scene's custom event is schedulable when its declaration opts in
// (`customEvents: [{name, origins: ["schedule"]}]`, the Events panel's
// checkbox): the panel offers those per scene, and the device refuses the rest.

import { isContractEvent, schedulableContractEvents } from './eventsContract'
import { CUSTOM_EVENT_MAX_NAME_LENGTH } from './eventsContract.gen'

export type ScheduledEventName = 'setCurrentScene' | 'restart' | 'reboot'
export type ScheduledSystemEventName = Exclude<ScheduledEventName, 'setCurrentScene'>

export interface ScheduledEventLike {
  event: string
  payload?: { sceneId?: string | null } | null
}

/** Schedulable events that are not a scene change: they end the runtime. */
export const scheduledSystemEvents: { value: ScheduledSystemEventName; label: string; description: string }[] =
  schedulableContractEvents()
    .filter(({ spec }) => spec.schedule?.endsRuntime)
    .map(({ name, spec }) => ({
      value: name as ScheduledSystemEventName,
      label: spec.schedule?.label ?? name,
      description: spec.schedule?.description ?? '',
    }))

export const scheduledEventOptions: { value: ScheduledEventName; label: string }[] = schedulableContractEvents().map(
  ({ name, spec }) => ({ value: name as ScheduledEventName, label: spec.schedule?.label ?? name })
)

/**
 * Cloud-managed frames: firmware from here on runs scheduled `restart` and
 * `reboot` entries (Pi: runner.nim `reboot` arm; ESP32: fos_schedule.c).
 * Older firmware fires them onto the scene as a silent no-op rather than
 * refusing the push, so the panel disables the buttons below the floor with
 * a reason instead of hiding them — the same convention as the settings
 * batches in cloudFrameSettings.ts.
 */
export const scheduledSystemEventsMinVersion =
  schedulableContractEvents().find(({ spec }) => spec.schedule?.endsRuntime)?.spec.schedule?.since ?? ''

export function isScheduledSystemEvent(event: string | null | undefined): event is ScheduledSystemEventName {
  return scheduledSystemEvents.some((option) => option.value === event)
}

/** An entry that fires a scene's custom event: any name that is not the contract's. */
export function isScheduledCustomEvent(event: string | null | undefined): boolean {
  return !!event && !isContractEvent(event)
}

export function scheduledEventIsSceneChange(event: ScheduledEventLike): boolean {
  return !isScheduledSystemEvent(event.event) && !isScheduledCustomEvent(event.event)
}

export interface SceneCustomEventsLike {
  id?: string
  name?: string
  customEvents?: readonly { name?: string; origins?: readonly string[] }[] | null
}

export interface ScheduledCustomEventGroup {
  /** The declaring scene's name. */
  label: string
  options: { value: string; label: string }[]
}

/**
 * The custom events a schedule may fire, grouped by the scene that declares
 * them with the `schedule` origin — the device's reading of the same array
 * (`declaredCustomEventOrigins`, frameos/events.nim). The entry fires
 * `{event: <name>, payload: {}}` at whichever scene is showing.
 */
export function schedulableCustomEventGroups(
  scenes: readonly SceneCustomEventsLike[] | null | undefined
): ScheduledCustomEventGroup[] {
  const groups: ScheduledCustomEventGroup[] = []
  for (const scene of scenes ?? []) {
    const names = new Set<string>()
    for (const event of scene.customEvents ?? []) {
      const name = String(event?.name ?? '').trim()
      if (
        name &&
        new TextEncoder().encode(name).length <= CUSTOM_EVENT_MAX_NAME_LENGTH &&
        !isContractEvent(name) &&
        Array.isArray(event.origins) &&
        event.origins.includes('schedule')
      ) {
        names.add(name)
      }
    }
    if (names.size > 0) {
      groups.push({
        label: scene.name || scene.id || 'Unnamed scene',
        options: [...names].map((name) => ({ value: name, label: name })),
      })
    }
  }
  return groups
}

export function scheduledSystemEventLabel(event: string | null | undefined): string {
  return scheduledSystemEvents.find((option) => option.value === event)?.label ?? (event || 'Unknown action')
}

/**
 * The one-line title of an entry: the scene's name for a scene change
 * (`sceneName` resolves it; `fallback` when the scene is gone), the action's
 * label for a maintenance entry, the event's name for a custom event.
 */
export function scheduledEventTitle(
  event: ScheduledEventLike,
  sceneName: (sceneId: string) => string | null | undefined,
  fallback = 'Unknown scene'
): string {
  if (isScheduledSystemEvent(event.event)) {
    return scheduledSystemEventLabel(event.event)
  }
  if (isScheduledCustomEvent(event.event)) {
    return event.event
  }
  const sceneId = event.payload?.sceneId
  return (sceneId ? sceneName(sceneId) : null) || fallback
}
