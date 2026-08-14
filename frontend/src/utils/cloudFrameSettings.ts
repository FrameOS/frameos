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

export const cloudFrameSettingKeys = ['debug', 'interval', 'name', 'rotate', 'scaling_mode', 'timezone'] as const

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

export type CloudFrameSettingKey = (typeof esp32CloudFrameSettingKeys)[number]

const numericSettingKeys: readonly CloudFrameSettingKey[] = [
  'interval',
  'rotate',
  'wake_check_seconds',
  'battery_pin',
  'battery_divider',
]

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
    if (value === undefined || value === null || value === '') {
      continue
    }
    // The form keeps numbers as strings; the control plane type-checks them.
    settings[key] = numericSettingKeys.includes(key) ? Number(value) : value
  }
  return settings
}
