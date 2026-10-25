// Voice chat on a frame (docs/voice-chat.md): whether the frame has a
// microphone at all, and what the owner lets the voice chat do.
//
// The three permission switches are plane-side policy, never a firmware
// setting: the cloud keeps them in the frame's `voice_permissions`
// (POST /api/frames/{id}/voice/permissions), the backend in the frame's
// device_config as voiceChangeSettings / voiceUseScenes / voiceCreateScenes
// (the device's settings poll never carries them). The planes read them when
// they build a voice turn's tools; this module is the SPA's reader and
// writer for both spellings. Keep the keys and defaults alike with
// cloud/apps/auth-web/src/lib/voice-permissions.ts and
// backend/app/utils/voice_chat.py.
import type { FrameEmbeddedHardwarePreset, FrameType } from '../types'

export const VOICE_PERMISSION_KEYS = ['change_settings', 'use_scenes', 'create_scenes'] as const
export type VoicePermissionKey = (typeof VOICE_PERMISSION_KEYS)[number]
export type VoicePermissions = Record<VoicePermissionKey, boolean>

/** Settings and the installed scenes are allowed; new scenes on the frame are opted into. */
export const DEFAULT_VOICE_PERMISSIONS: VoicePermissions = {
  change_settings: true,
  use_scenes: true,
  create_scenes: false,
}

type VoicePermissionDeviceConfigKeys = {
  camel: 'voiceChangeSettings' | 'voiceUseScenes' | 'voiceCreateScenes'
  snake: 'voice_change_settings' | 'voice_use_scenes' | 'voice_create_scenes'
}

/** The backend's spelling: camelCase first, the snake_case twin a USB provisioning might have left. */
export const VOICE_PERMISSION_DEVICE_CONFIG_KEYS: Record<VoicePermissionKey, VoicePermissionDeviceConfigKeys> = {
  change_settings: { camel: 'voiceChangeSettings', snake: 'voice_change_settings' },
  use_scenes: { camel: 'voiceUseScenes', snake: 'voice_use_scenes' },
  create_scenes: { camel: 'voiceCreateScenes', snake: 'voice_create_scenes' },
}

/** The cloud's object (`voice_permissions`) as permissions: a key that is not a boolean keeps its default. */
export function voicePermissionsOf(value: unknown): VoicePermissions {
  const out: VoicePermissions = { ...DEFAULT_VOICE_PERMISSIONS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return out
  }
  const stored = value as Record<string, unknown>
  for (const key of VOICE_PERMISSION_KEYS) {
    if (typeof stored[key] === 'boolean') {
      out[key] = stored[key] as boolean
    }
  }
  return out
}

type DeviceConfig = NonNullable<FrameType['device_config']>

/** The backend's spelling as permissions: the camelCase key wins over the snake_case copy. */
export function voicePermissionsFromDeviceConfig(deviceConfig: DeviceConfig | null | undefined): VoicePermissions {
  const out: VoicePermissions = { ...DEFAULT_VOICE_PERMISSIONS }
  if (!deviceConfig) {
    return out
  }
  for (const key of VOICE_PERMISSION_KEYS) {
    const { camel, snake } = VOICE_PERMISSION_DEVICE_CONFIG_KEYS[key]
    const value = deviceConfig[camel] ?? deviceConfig[snake]
    if (typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

/** device_config with one switch written: the camelCase key, the snake_case copy dropped (the device would keep reading the stale one it checks first). */
export function deviceConfigWithVoicePermission(
  deviceConfig: DeviceConfig | null | undefined,
  key: VoicePermissionKey,
  enabled: boolean
): DeviceConfig {
  const { camel, snake } = VOICE_PERMISSION_DEVICE_CONFIG_KEYS[key]
  const next: DeviceConfig = { ...(deviceConfig ?? {}) }
  delete next[snake]
  next[camel] = enabled
  return next
}

/**
 * Boards whose preset carries a PDM microphone (docs/voice-chat.md "Boards").
 * Mirrors the backend's EMBEDDED_SEEED_RETERMINAL_MIC presets and
 * fos_board.c's k_mics table; the E1004 has none.
 */
export const EMBEDDED_PRESETS_WITH_MICROPHONE: readonly FrameEmbeddedHardwarePreset[] = [
  'seeed_reterminal_e1001',
  'seeed_reterminal_e1002',
]

/**
 * What the configured microphone pins say: true when the clock and the data
 * line are both set to a GPIO, false when either is -1 (no microphone), null
 * when they are left to the board's own (unset, or only one of them set).
 */
export function configuredMicrophone(clkPin: number | undefined, dataPin: number | undefined): boolean | null {
  if ((clkPin !== undefined && clkPin < 0) || (dataPin !== undefined && dataPin < 0)) {
    return false
  }
  if (clkPin !== undefined && dataPin !== undefined) {
    return true
  }
  return null
}

/**
 * A backend-managed ESP32 frame has a microphone when its device_config names
 * one (either spelling), or, pins left to the board, when its preset carries
 * one. Virtual frames and Picos never do; the caller keeps those out.
 */
export function backendFrameHasMicrophone(
  deviceConfig: DeviceConfig | null | undefined,
  hardwarePreset: FrameEmbeddedHardwarePreset | string | null | undefined
): boolean {
  const configured = configuredMicrophone(
    deviceConfig?.micClkPin ?? deviceConfig?.mic_clk_pin,
    deviceConfig?.micDataPin ?? deviceConfig?.mic_data_pin
  )
  if (configured !== null) {
    return configured
  }
  return EMBEDDED_PRESETS_WITH_MICROPHONE.includes(hardwarePreset as FrameEmbeddedHardwarePreset)
}

/**
 * A cloud-managed ESP32 frame has a microphone when the form's pins name one
 * (a push on its way), or, pins left to the board, when the frame reported one
 * in its hello (`hardware.microphone`). Nothing reported and nothing set is
 * no microphone: the controls appear once the frame says so, or once pins are set.
 */
export function cloudFrameHasMicrophone(
  hardware: FrameType['hardware'] | null | undefined,
  form: { mic_clk_pin?: number; mic_data_pin?: number }
): boolean {
  const configured = configuredMicrophone(form.mic_clk_pin, form.mic_data_pin)
  if (configured !== null) {
    return configured
  }
  return hardware?.microphone === true
}
