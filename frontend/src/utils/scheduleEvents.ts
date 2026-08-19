// What a schedule entry can do, shared by the Schedule panel, the workspace
// cards and the dashboard so a non-scene entry never renders as "Unknown
// scene". Deliberately import-free (no types barrel): the shape below is the
// subset of ScheduledEvent these helpers need.
//
// The device fires whatever event name an entry carries onto its runtime
// event queue (frameos/scheduler.nim, embedded/esp32/main/fos_schedule.c),
// so the list here is a UI allowlist, not a protocol one: `setCurrentScene`
// is handled by the runner, `restart` exits the runtime (systemd brings it
// back), `reboot` runs the device's privileged reboot. On the ESP32 the last
// two are the same esp_restart().

export type ScheduledEventName = 'setCurrentScene' | 'restart' | 'reboot'
export type ScheduledSystemEventName = Exclude<ScheduledEventName, 'setCurrentScene'>

export interface ScheduledEventLike {
  event: string
  payload?: { sceneId?: string | null } | null
}

export const scheduledSystemEvents: { value: ScheduledSystemEventName; label: string; description: string }[] = [
  {
    value: 'restart',
    label: 'Restart FrameOS',
    description: 'Exit and relaunch the FrameOS runtime. A few seconds of downtime; the device stays up.',
  },
  {
    value: 'reboot',
    label: 'Reboot device',
    description: 'Reboot the whole device. Use this for the nightly reboot some panels and Wi-Fi chips like.',
  },
]

export const scheduledEventOptions: { value: ScheduledEventName; label: string }[] = [
  { value: 'setCurrentScene', label: 'Show a scene' },
  ...scheduledSystemEvents.map(({ value, label }) => ({ value, label })),
]

/**
 * Cloud-managed frames: firmware from here on runs scheduled `restart` and
 * `reboot` entries (Pi: runner.nim `reboot` arm; ESP32: fos_schedule.c).
 * Older firmware fires them onto the scene as a silent no-op rather than
 * refusing the push, so the panel disables the buttons below the floor with
 * a reason instead of hiding them — the same convention as the settings
 * batches in cloudFrameSettings.ts.
 */
export const scheduledSystemEventsMinVersion = '2026.8.32'

export function isScheduledSystemEvent(event: string | null | undefined): event is ScheduledSystemEventName {
  return event === 'restart' || event === 'reboot'
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
