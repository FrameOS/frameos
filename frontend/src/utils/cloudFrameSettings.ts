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

export const esp32CloudFrameSettingKeys = [...cloudFrameSettingKeys, ...esp32PowerSettingKeys] as const

/** Every key any cloud frame can be sent — the superset the drift test pins. */
export const allCloudFrameSettingKeys = [
  ...cloudFrameSettingKeys,
  ...extendedCloudFrameSettingKeys,
  ...esp32PowerSettingKeys,
] as const

export type CloudFrameSettingKey = (typeof allCloudFrameSettingKeys)[number]

/**
 * The keys a Pi/Linux cloud frame reporting `frameosVersion` can be sent:
 * the base six, plus the extended batch once the firmware knows it.
 */
export function cloudFrameSettingKeysForVersion(frameosVersion: string | null | undefined): CloudFrameSettingKey[] {
  return cloudFrameSupportsExtendedSettings(frameosVersion)
    ? [...cloudFrameSettingKeys, ...extendedCloudFrameSettingKeys]
    : [...cloudFrameSettingKeys]
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
  if (typeof frameosVersion !== 'string' || frameosVersion.trim().length === 0) {
    return false
  }
  const target = frameosVersionKey(frameosVersion)
  if (!target) {
    return true
  }
  const minimum = frameosVersionKey(extendedCloudFrameSettingsMinVersion) ?? []
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
