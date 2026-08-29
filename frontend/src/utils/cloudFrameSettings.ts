// The declarative settings a FrameOS Cloud frame accepts, per profile and
// firmware version — read from the verb contract (docs/cloud-frames-contract.json
// → cloudFramesContract.gen.ts). The cloud (cloud-frames-contract.gen.ts),
// the Linux runtime and the ESP32 firmware read the same document, so the
// SPA can never offer a key the device would refuse the whole push on.
//
// Deliberately import-free beyond the generated table: the cloud's shared-spa
// tests run this in node, and the SPA's type barrel drags in reactflow and
// the whole device catalogue.
import { cloudFramesContractSettings } from './cloudFramesContract.gen'

// The keys a client may SEND: companion keys (the ESP32's tzdata slice) are
// attached by the cloud and never bound by the form, so they are not part of
// the type either — every consumer types these as `keyof FrameType`.
type SendableKey<P> = { [K in keyof P]: P[K] extends { companion: string } ? never : K }[keyof P]
type LinuxKey = SendableKey<typeof cloudFramesContractSettings.linux>
type Esp32Key = SendableKey<typeof cloudFramesContractSettings.esp32>
export type CloudFrameSettingKey = LinuxKey | Esp32Key

interface ContractEntry {
  since: string | null
  restart?: boolean
  companion?: string
}

const linuxEntries = cloudFramesContractSettings.linux as Readonly<Record<string, ContractEntry>>
const esp32Entries = cloudFramesContractSettings.esp32 as Readonly<Record<string, ContractEntry>>

/**
 * The keys a profile takes at exactly firmware floor `since` (null = every
 * version), in contract order. Companion keys (the ESP32's tzdata slice) are
 * never the SPA's to send — the cloud attaches them.
 */
function linuxKeysSince(since: string | null): LinuxKey[] {
  return (Object.keys(linuxEntries) as LinuxKey[]).filter(
    (key) => linuxEntries[key]?.since === since && !linuxEntries[key]?.companion
  )
}
function esp32KeysSince(since: string | null): Esp32Key[] {
  return (Object.keys(esp32Entries) as Esp32Key[]).filter(
    (key) => esp32Entries[key]?.since === since && !esp32Entries[key]?.companion
  )
}

/** The original six: every managed Linux frame, whatever its firmware, applies these. */
export const cloudFrameSettingKeys: readonly LinuxKey[] = linuxKeysSince(null)

/** Firmware from here on knows the extended keys. */
export const extendedCloudFrameSettingsMinVersion = '2026.8.30'

/**
 * The 2026.8.30 batch, Pi/Linux runtime only. Every key maps onto a field of
 * the same name in FrameType, but the WIRE shape of the structured ones is
 * the runtime's, not the form's — cloudFrameSettingsPayload converts. A frame
 * on older firmware refuses the whole push on the first of these it sees,
 * so callers gate on cloudFrameSupportsExtendedSettings(frame.frameos_version)
 * and only then include extendedCloudFrameSettingKeys.
 */
export const extendedCloudFrameSettingKeys: readonly LinuxKey[] = linuxKeysSince(extendedCloudFrameSettingsMinVersion)

/** Firmware from here on knows the hardware keys. */
export const hardwareCloudFrameSettingsMinVersion = '2026.8.31'

/**
 * The 2026.8.31 hardware batch, Pi/Linux runtime only: the display palette,
 * the partial-refresh subset of device_config, and the GPIO button map. The
 * device's display driver reads all three at init, so a push carrying one
 * restarts the runtime (a few seconds of blank panel on e-ink). Which of them
 * apply to a given frame depends on the panel it reported
 * (`frame.hardware.device`) — the panel renders only the applicable fields —
 * and callers gate on cloudFrameSupportsHardwareSettings(frame.frameos_version)
 * before including hardwareCloudFrameSettingKeys.
 */
export const hardwareCloudFrameSettingKeys: readonly LinuxKey[] = linuxKeysSince(hardwareCloudFrameSettingsMinVersion)

/**
 * Power-management keys only the ESP32 firmware consumes. The Linux runtime
 * refuses the whole verb on them, so callers include them only for esp32
 * frames (frameLogic gates on isEsp32CloudFrame). This is the list the frame
 * form keys, diffs and normalizes on (frameLogic FRAME_KEYS / frameDiffKeys);
 * what is actually SENT is esp32CloudFrameSettingKeysForVersion.
 */
export const esp32PowerSettingKeys: readonly Esp32Key[] = (Object.keys(esp32Entries) as Esp32Key[]).filter(
  (key) => !(key in linuxEntries) && !esp32Entries[key]?.companion
)

/**
 * 2026.8.39: the battery divider's enable GPIO (reTerminal E1004 switches
 * its divider on through GPIO 21 while sampling). Read at boot next to
 * battery_pin. Older firmware refuses the whole push on it — its own floor,
 * like the two tails below.
 */
export const esp32BatteryEnablePinCloudFrameSettingsMinVersion = '2026.8.39'
export const esp32BatteryEnablePinCloudFrameSettingKeys: readonly Esp32Key[] = esp32KeysSince(
  esp32BatteryEnablePinCloudFrameSettingsMinVersion
)

export function cloudFrameSupportsEsp32BatteryEnablePin(frameosVersion: string | null | undefined): boolean {
  return cloudFrameSupportsSettingsFrom(esp32BatteryEnablePinCloudFrameSettingsMinVersion, frameosVersion)
}

/**
 * What every ESP32 firmware with the cloud link applies: four of the base
 * six (no timezone before 2026.8.34, no debug before 2026.8.31) plus the
 * ungated power keys.
 */
export const esp32CloudFrameSettingKeys: readonly Esp32Key[] = esp32KeysSince(null)

/**
 * What the ESP32 firmware learned in 2026.8.31: debug logging (live), the
 * per-request HTTP ceiling and the GPIO button map (both read at boot, so
 * the firmware reboots after persisting them). Older firmware refuses the
 * whole push on them — callers gate on cloudFrameSupportsEsp32ExtendedSettings.
 */
export const esp32ExtendedCloudFrameSettingsMinVersion = '2026.8.31'
export const esp32ExtendedCloudFrameSettingKeys: readonly Esp32Key[] = esp32KeysSince(
  esp32ExtendedCloudFrameSettingsMinVersion
)
export const esp32MaxCloudGpioButtons = 8

export function cloudFrameSupportsEsp32ExtendedSettings(frameosVersion: string | null | undefined): boolean {
  return cloudFrameSupportsSettingsFrom(esp32ExtendedCloudFrameSettingsMinVersion, frameosVersion)
}

/**
 * 2026.8.34: the ESP32 firmware maps an IANA zone name onto a POSIX TZ rule
 * (fos_tz.c) and applies it live, so the Pi's `timezone` wire key reaches
 * the chip too — behind its own floor.
 */
export const esp32TimeZoneCloudFrameSettingsMinVersion = '2026.8.34'
export const esp32TimeZoneCloudFrameSettingKeys: readonly Esp32Key[] = esp32KeysSince(
  esp32TimeZoneCloudFrameSettingsMinVersion
)

export function cloudFrameSupportsEsp32TimeZone(frameosVersion: string | null | undefined): boolean {
  return cloudFrameSupportsSettingsFrom(esp32TimeZoneCloudFrameSettingsMinVersion, frameosVersion)
}

/**
 * The keys an ESP32 cloud frame reporting `frameosVersion` can be sent: the
 * base set, then each gated batch its firmware knows, in floor order.
 */
export function esp32CloudFrameSettingKeysForVersion(
  frameosVersion: string | null | undefined
): CloudFrameSettingKey[] {
  return keysForVersion(esp32Entries, frameosVersion) as CloudFrameSettingKey[]
}

/** Every key any profile takes: what the form binds and diffs on. */
export const allCloudFrameSettingKeys: readonly CloudFrameSettingKey[] = Array.from(
  new Set<CloudFrameSettingKey>([
    ...cloudFrameSettingKeys,
    ...extendedCloudFrameSettingKeys,
    ...hardwareCloudFrameSettingKeys,
    ...esp32PowerSettingKeys,
  ])
)

/**
 * The keys a Pi/Linux cloud frame reporting `frameosVersion` can be sent:
 * the base six, then each gated batch its firmware knows, in floor order.
 */
export function cloudFrameSettingKeysForVersion(frameosVersion: string | null | undefined): CloudFrameSettingKey[] {
  return keysForVersion(linuxEntries, frameosVersion) as CloudFrameSettingKey[]
}

function keysForVersion<K extends string>(
  entries: Readonly<Record<K, ContractEntry>>,
  frameosVersion: string | null | undefined
): K[] {
  const keys = Object.keys(entries) as K[]
  const floors = Array.from(
    new Set(keys.map((key) => entries[key]?.since ?? null).filter((since): since is string => since !== null))
  ).sort(compareVersions)
  const result: K[] = keys.filter((key) => entries[key]?.since === null && !entries[key]?.companion)
  for (const floor of floors) {
    if (!cloudFrameSupportsSettingsFrom(floor, frameosVersion)) continue
    result.push(...keys.filter((key) => entries[key]?.since === floor && !entries[key]?.companion))
  }
  return result
}

/**
 * Does firmware `frameosVersion` understand the extended batch? Mirrors
 * frameSupportsExtendedSettings on the control plane (cloud/apps/auth-web/
 * src/lib/frames.ts) — the two must agree or the SPA offers fields the route
 * refuses.
 */
export function cloudFrameSupportsExtendedSettings(frameosVersion: string | null | undefined): boolean {
  return cloudFrameSupportsSettingsFrom(extendedCloudFrameSettingsMinVersion, frameosVersion)
}

/** Same for the hardware batch. */
export function cloudFrameSupportsHardwareSettings(frameosVersion: string | null | undefined): boolean {
  return cloudFrameSupportsSettingsFrom(hardwareCloudFrameSettingsMinVersion, frameosVersion)
}

/**
 * The one version rule every gate above shares:
 *  - a parseable version compares numerically against the floor;
 *  - a non-empty but unparseable one ("unknown", a dev build) is trusted —
 *    dev builds carry the newest code;
 *  - null/empty (the frame never reported one, i.e. never connected) is not.
 */
export function cloudFrameSupportsSettingsFrom(minVersion: string, frameosVersion: string | null | undefined): boolean {
  if (typeof frameosVersion !== 'string' || frameosVersion.trim().length === 0) {
    return false
  }
  const reported = parseVersion(frameosVersion)
  if (!reported) {
    return true
  }
  return compareVersions(frameosVersion, minVersion) >= 0
}

type VersionTriple = [number, number, number]

function parseVersion(version: string): VersionTriple | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) {
    return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(a: string, b: string): number {
  const left: VersionTriple = parseVersion(a) ?? [0, 0, 0]
  const right: VersionTriple = parseVersion(b) ?? [0, 0, 0]
  if (left[0] !== right[0]) return left[0] - right[0]
  if (left[1] !== right[1]) return left[1] - right[1]
  return left[2] - right[2]
}

export const numericCloudFrameSettingKeys: readonly CloudFrameSettingKey[] = [
  'interval',
  'rotate',
  'wake_check_seconds',
  'battery_pin',
  'battery_divider',
  'battery_enable_pin',
  'metrics_interval',
  'max_http_response_bytes',
]
const numericSettingKeys = numericCloudFrameSettingKeys

/** Keys where the empty string is itself a value ("no flip"), not "unset". */
const emptyStringIsValue: readonly CloudFrameSettingKey[] = ['flip']

const controlCodePositions = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']
const htmlHexColor = /^#[0-9a-fA-F]{6}$/

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toInteger(value: unknown): number | undefined {
  const parsed = toNumber(value)
  return parsed === undefined ? undefined : Math.trunc(parsed)
}

/**
 * The form's control_code (Select-friendly strings: enabled 'true'/'false',
 * numbers as text) → the runtime's controlCode shape the validators want
 * (bool, numbers, #rrggbb). Unparseable sub-values are dropped rather than
 * sent — one bad sub-key refuses the whole push. Undefined when the form
 * holds nothing at all.
 */
export function cloudControlCodePayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const form = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (form.enabled !== undefined && form.enabled !== null && form.enabled !== '') {
    out.enabled = form.enabled === true || form.enabled === 'true'
  }
  if (typeof form.position === 'string' && controlCodePositions.includes(form.position)) {
    out.position = form.position
  }
  const size = toNumber(form.size)
  if (size !== undefined) {
    out.size = size
  }
  for (const key of ['padding', 'offsetX', 'offsetY'] as const) {
    const parsed = toInteger(form[key])
    if (parsed !== undefined) {
      out[key] = parsed
    }
  }
  for (const key of ['qrCodeColor', 'backgroundColor'] as const) {
    if (typeof form[key] === 'string' && htmlHexColor.test(form[key] as string)) {
      out[key] = form[key]
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** error_behavior with the numeric fields coerced and unknown keys dropped. */
export function cloudErrorBehaviorPayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const form = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (form.mode === 'safe_mode' || form.mode === 'show_error_retry' || form.mode === 'silent_retry') {
    out.mode = form.mode
  }
  if (typeof form.silent_retry_forever === 'boolean') {
    out.silent_retry_forever = form.silent_retry_forever
  }
  for (const key of [
    'retry_seconds',
    'silent_retry_seconds',
    'silent_window_minutes',
    'show_error_retry_seconds',
  ] as const) {
    const parsed = toNumber(form[key])
    if (parsed !== undefined && parsed > 0) {
      out[key] = parsed
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * timezone_updater: enabled + hour only. The URL is never sent — a provider
 * does not get to point a frame's tz download anywhere (docs/todo.md), and
 * the device carries its own URL across the write.
 */
export function cloudTimezoneUpdaterPayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const form = value as Record<string, unknown>
  const out: Record<string, unknown> = { enabled: form.enabled !== false }
  const hour = toInteger(form.hour)
  if (hour !== undefined && hour >= 0 && hour <= 23) {
    out.hour = hour
  }
  return out
}

/** save_assets: a boolean, or a keyword → boolean map with nothing else in it. */
export function cloudSaveAssetsPayload(value: unknown): boolean | Record<string, boolean> | undefined {
  if (typeof value === 'boolean') {
    return value
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const out: Record<string, boolean> = {}
  for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 0 && key.length <= 64 && typeof flag === 'boolean') {
      out[key] = flag
    }
  }
  return out
}

/**
 * palette: the SPA's Palette ({name?, colors, colorNames?}) with every colour
 * a "#rrggbb". One unparseable colour drops the whole palette from the push
 * (a partial palette would shift every colour after it on the panel).
 * Undefined when there is nothing to send.
 */
export function cloudPalettePayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const form = value as { name?: unknown; colors?: unknown; colorNames?: unknown }
  if (!Array.isArray(form.colors)) {
    return undefined
  }
  const colors: string[] = []
  for (const color of form.colors) {
    if (typeof color !== 'string' || !htmlHexColor.test(color)) {
      return undefined
    }
    colors.push(color)
  }
  const out: Record<string, unknown> = { colors }
  if (typeof form.name === 'string' && form.name.length > 0 && form.name.length <= 64) {
    out.name = form.name
  }
  if (
    Array.isArray(form.colorNames) &&
    form.colorNames.length === colors.length &&
    form.colorNames.every((n) => typeof n === 'string' && n.length <= 32)
  ) {
    out.colorNames = form.colorNames
  }
  return out
}

/**
 * device_config: ONLY the partial-refresh policy — partial, partialMaxAreaPercent,
 * partialMaxRefreshesBeforeFull — coerced from the form's strings. Everything
 * else in the form's device_config (VCOM, pins, upload URL, SD card, …) is the
 * device's own and never rides a cloud push. Undefined when none is set.
 */
export function cloudPartialRefreshPayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const form = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (form.partial !== undefined && form.partial !== null && form.partial !== '') {
    out.partial = form.partial === true || form.partial === 'true'
  }
  const area = toNumber(form.partialMaxAreaPercent)
  if (area !== undefined && area >= 0 && area <= 100) {
    out.partialMaxAreaPercent = area
  }
  const refreshes = toInteger(form.partialMaxRefreshesBeforeFull)
  if (refreshes !== undefined && refreshes >= 0) {
    out.partialMaxRefreshesBeforeFull = refreshes
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * gpio_buttons: [{pin, label}] with pins as integers and labels trimmed.
 * Rows the form left blank (no pin) are skipped; a row with a pin but an
 * unusable label or a duplicate pin drops the whole list from the push,
 * since the device refuses it and would take every other setting down.
 * An empty list IS sent — it unbinds every button.
 */
export function cloudGpioButtonsPayload(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const out: Record<string, unknown>[] = []
  const pins = new Set<number>()
  for (const row of value) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const { pin, label } = row as { pin?: unknown; label?: unknown }
    if (pin === undefined || pin === null || pin === '') {
      continue
    }
    const parsedPin = toInteger(pin)
    const trimmedLabel = typeof label === 'string' ? label.trim() : ''
    if (parsedPin === undefined || parsedPin < 0 || trimmedLabel.length === 0 || trimmedLabel.length > 32) {
      return undefined
    }
    if (pins.has(parsedPin)) {
      return undefined
    }
    pins.add(parsedPin)
    out.push({ pin: parsedPin, label: trimmedLabel })
  }
  return out
}

/**
 * Pick just the keys the cloud accepts, dropping unset ones — the control
 * plane's validator rejects null/empty values, and a rejected key takes the
 * whole push down with it.
 */
export function cloudFrameSettingsPayload(
  frame: Partial<Record<CloudFrameSettingKey, unknown>>,
  keys: readonly CloudFrameSettingKey[] = cloudFrameSettingKeys
): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  for (const key of keys) {
    const value = frame[key]
    if (value === undefined || value === null) {
      continue
    }
    if (value === '' && !emptyStringIsValue.includes(key)) {
      continue
    }
    let converted: unknown
    switch (key) {
      case 'control_code':
        converted = cloudControlCodePayload(value)
        break
      case 'error_behavior':
        converted = cloudErrorBehaviorPayload(value)
        break
      case 'timezone_updater':
        converted = cloudTimezoneUpdaterPayload(value)
        break
      case 'save_assets':
        converted = cloudSaveAssetsPayload(value)
        break
      case 'palette':
        converted = cloudPalettePayload(value)
        break
      case 'device_config':
        converted = cloudPartialRefreshPayload(value)
        break
      case 'gpio_buttons':
        converted = cloudGpioButtonsPayload(value)
        break
      default:
        // The form keeps numbers as strings; the control plane type-checks them.
        converted = numericSettingKeys.includes(key) ? Number(value) : value
    }
    if (converted === undefined) {
      continue
    }
    settings[key] = converted
  }
  return settings
}
