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
// every event whose `origins` list "schedule", and any custom scene event —
// so this is still a UI list, only no longer a second one.

import { schedulableContractEvents } from './eventsContract'

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

export function scheduledEventIsSceneChange(event: ScheduledEventLike): boolean {
  return !isScheduledSystemEvent(event.event)
}

export function scheduledSystemEventLabel(event: string | null | undefined): string {
  return scheduledSystemEvents.find((option) => option.value === event)?.label ?? (event || 'Unknown action')
}

/**
 * The one-line title of an entry: the scene's name for a scene change
 * (`sceneName` resolves it; `fallback` when the scene is gone), the action's
 * label otherwise.
 */
export function scheduledEventTitle(
  event: ScheduledEventLike,
  sceneName: (sceneId: string) => string | null | undefined,
  fallback = 'Unknown scene'
): string {
  if (isScheduledSystemEvent(event.event)) {
    return scheduledSystemEventLabel(event.event)
  }
  const sceneId = event.payload?.sceneId
  return (sceneId ? sceneName(sceneId) : null) || fallback
}
