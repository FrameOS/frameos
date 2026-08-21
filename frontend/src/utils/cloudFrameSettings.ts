// The declarative settings a FrameOS Cloud frame accepts, and nothing else.
//
// This list is declared three times and all three must agree: here,
// `allowedFrameSettings` in cloud/apps/auth-web/src/lib/frames.ts, and
// CLOUD_SETTINGS_ALLOWLIST in frameos/src/frameos/cloud/hub_client.nim. The
// device refuses the WHOLE verb when it sees a key it does not know, so one
// extra or misspelled key here silently drops every setting in the push —
// cloud/apps/auth-web/src/test/shared-spa/cloud-frame-settings.test.ts pins
// the agreement between the first two.
//
// Deliberately import-free: that test runs in node, and the SPA's type barrel
// drags in reactflow and the whole device catalogue.

/** The original six: every managed frame, whatever its firmware, applies these. */
export const cloudFrameSettingKeys = ['debug', 'interval', 'name', 'rotate', 'scaling_mode', 'timezone'] as const

/**
 * The 2026.8.30 batch, Pi/Linux runtime only. Every key maps onto a field of
 * the same name in FrameType, but the WIRE shape of the structured ones is
 * the runtime's, not the form's — cloudFrameSettingsPayload converts. A frame
 * on older firmware refuses the whole push on the first of these it sees,
 * so callers gate on cloudFrameSupportsExtendedSettings(frame.frameos_version)
 * and only then include extendedCloudFrameSettingKeys.
 */
export const extendedCloudFrameSettingKeys = [
  'flip',
  'error_behavior',
  'control_code',
  'metrics_interval',
  'max_http_response_bytes',
  'save_assets',
  'timezone_updater',
] as const

/** Firmware from here on knows the extended keys (CLOUD_SETTINGS_ALLOWLIST). */
export const extendedCloudFrameSettingsMinVersion = '2026.8.30'

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
export const hardwareCloudFrameSettingKeys = ['palette', 'device_config', 'gpio_buttons'] as const

/** Firmware from here on knows the hardware keys. */
export const hardwareCloudFrameSettingsMinVersion = '2026.8.31'

/**
 * Power-management keys only the ESP32 firmware consumes. The Nim runtime's
 * CLOUD_SETTINGS_ALLOWLIST does not know them, so pushing them at a Pi frame
 * drops the whole verb — callers must include them only for esp32 frames
 * (frameLogic gates on isEsp32CloudFrame).
 */
export const esp32PowerSettingKeys = [
  'deep_sleep',
  'deep_sleep_on_battery',
  'wake_check_seconds',
  'battery_pin',
  'battery_divider',
] as const

/**
 * What every ESP32 firmware with the cloud link applies: four of the base
 * six (no timezone before 2026.8.34 — see esp32TimeZoneCloudFrameSettingKeys
 * — and no debug before 2026.8.31) plus the power keys. Mirrors esp32SettableKeys on the control
 * plane minus its version-gated tail.
 */
export const esp32CloudFrameSettingKeys = [
  'interval',
  'name',
  'rotate',
  'scaling_mode',
  ...esp32PowerSettingKeys,
] as const

/**
 * What the ESP32 firmware learned in 2026.8.31: debug logging (live), the
 * per-request HTTP ceiling and the GPIO button map (both read at boot, so
 * the firmware reboots after persisting them). Older firmware refuses the
 * whole push on them — callers gate on cloudFrameSupportsEsp32ExtendedSettings.
 * `debug` and `max_http_response_bytes` are the same wire keys the Pi runtime
 * takes; the SPA's esp32 profile simply did not send them before.
 */
export const esp32ExtendedCloudFrameSettingKeys = ['debug', 'max_http_response_bytes', 'gpio_buttons'] as const
export const esp32ExtendedCloudFrameSettingsMinVersion = '2026.8.31'
export const esp32MaxCloudGpioButtons = 8

export function cloudFrameSupportsEsp32ExtendedSettings(frameosVersion: string | null | undefined): boolean {
  return cloudFrameSupportsSettingsFrom(esp32ExtendedCloudFrameSettingsMinVersion, frameosVersion)
}

/**
 * 2026.8.34: the ESP32 firmware maps an IANA zone name onto a POSIX TZ rule
 * (fos_tz.c) and applies it live, so the Pi's `timezone` wire key reaches
 * the chip too — behind its own floor. Mirrors esp32TimeZoneFrameSettingKeys
 * on the control plane.
 */
export const esp32TimeZoneCloudFrameSettingKeys = ['timezone'] as const
export const esp32TimeZoneCloudFrameSettingsMinVersion = '2026.8.34'

export function cloudFrameSupportsEsp32TimeZone(frameosVersion: string | null | undefined): boolean {
  return cloudFrameSupportsSettingsFrom(esp32TimeZoneCloudFrameSettingsMinVersion, frameosVersion)
}

/** The keys an ESP32 cloud frame reporting `frameosVersion` can be sent. */
export function esp32CloudFrameSettingKeysForVersion(
  frameosVersion: string | null | undefined
): CloudFrameSettingKey[] {
  const keys: CloudFrameSettingKey[] = [...esp32CloudFrameSettingKeys]
  if (cloudFrameSupportsEsp32ExtendedSettings(frameosVersion)) {
    keys.push(...esp32ExtendedCloudFrameSettingKeys)
  }
  if (cloudFrameSupportsEsp32TimeZone(frameosVersion)) {
    keys.push(...esp32TimeZoneCloudFrameSettingKeys)
  }
  return keys
}

/** Every key any cloud frame can be sent — the superset the drift test pins. */
export const allCloudFrameSettingKeys = [
  ...cloudFrameSettingKeys,
  ...extendedCloudFrameSettingKeys,
  ...hardwareCloudFrameSettingKeys,
  ...esp32PowerSettingKeys,
] as const

export type CloudFrameSettingKey = (typeof allCloudFrameSettingKeys)[number]

/**
 * The keys a Pi/Linux cloud frame reporting `frameosVersion` can be sent:
 * the base six, plus each later batch once the firmware knows it.
 */
export function cloudFrameSettingKeysForVersion(frameosVersion: string | null | undefined): CloudFrameSettingKey[] {
  const keys: CloudFrameSettingKey[] = [...cloudFrameSettingKeys]
  if (cloudFrameSupportsExtendedSettings(frameosVersion)) {
    keys.push(...extendedCloudFrameSettingKeys)
  }
  if (cloudFrameSupportsHardwareSettings(frameosVersion)) {
    keys.push(...hardwareCloudFrameSettingKeys)
  }
  return keys
}

/**
 * Does firmware `frameosVersion` understand the extended batch? Mirrors
 * frameSupportsExtendedSettings in cloud/apps/auth-web/src/lib/frames.ts —
 * the two MUST agree, or the SPA offers fields the route then refuses:
 *  - a parseable version compares numerically against the minimum ("2026.10.0"
 *    is newer than "2026.9.0", so never compare as strings);
 *  - a non-empty but unparseable one ("unknown": a dev build) is trusted;
 *  - null/empty (never reported = never connected) is not.
 */
export function cloudFrameSupportsExtendedSettings(frameosVersion: string | null | undefined): boolean {
  return cloudFrameSupportsSettingsFrom(extendedCloudFrameSettingsMinVersion, frameosVersion)
}

/** Same three answers, against the hardware batch's floor. */
export function cloudFrameSupportsHardwareSettings(frameosVersion: string | null | undefined): boolean {
  return cloudFrameSupportsSettingsFrom(hardwareCloudFrameSettingsMinVersion, frameosVersion)
}

export function cloudFrameSupportsSettingsFrom(minVersion: string, frameosVersion: string | null | undefined): boolean {
  if (typeof frameosVersion !== 'string' || frameosVersion.trim().length === 0) {
    return false
  }
  const target = frameosVersionKey(frameosVersion)
  if (!target) {
    return true
  }
  const minimum = frameosVersionKey(minVersion) ?? []
  for (let index = 0; index < 4; index += 1) {
    const diff = (target[index] ?? 0) - (minimum[index] ?? 0)
    if (diff !== 0) {
      return diff > 0
    }
  }
  return true
}

/** "2026.8.30", "v2026.8.30+abc" → [2026, 8, 30, 0]; "unknown" → undefined. */
function frameosVersionKey(value: string): number[] | undefined {
  const match = /^[0-9]+(?:\.[0-9]+)*/.exec(value.trim().replace(/^v/i, ''))
  if (!match) {
    return undefined
  }
  const key = match[0]
    .split('.')
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 10))
  while (key.length < 4) {
    key.push(0)
  }
  return key
}

const numericSettingKeys: readonly CloudFrameSettingKey[] = [
  'interval',
  'rotate',
  'wake_check_seconds',
  'battery_pin',
  'battery_divider',
  'metrics_interval',
  'max_http_response_bytes',
]

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
