// Voice chat on a frame (docs/voice-chat.md): whether the frame has a
// microphone at all, and what the owner lets the voice chat do.
//
// The four permission switches are plane-side policy, never a firmware
// setting: the cloud keeps them in the frame's `voice_permissions`
// (POST /api/frames/{id}/voice/permissions), the backend in the frame's
// device_config as voiceChangeSettings / voiceUseScenes / voiceCreateScenes /
// voiceUseAlbums (the device's settings poll never carries them). The planes
// read them when they build a voice turn's tools; this module is the SPA's
// reader and writer for both spellings. Keep the keys and defaults alike with
// cloud/apps/auth-web/src/lib/voice-permissions.ts and
// backend/app/utils/voice_chat.py.
import type { FrameEmbeddedHardwarePreset, FrameType } from '../types'

export const VOICE_PERMISSION_KEYS = ['change_settings', 'use_scenes', 'create_scenes', 'use_albums'] as const
export type VoicePermissionKey = (typeof VOICE_PERMISSION_KEYS)[number]
export type VoicePermissions = Record<VoicePermissionKey, boolean>

/** Settings, the installed scenes and the photo albums are allowed; new scenes on the frame are opted into. */
export const DEFAULT_VOICE_PERMISSIONS: VoicePermissions = {
  change_settings: true,
  use_scenes: true,
  create_scenes: false,
  use_albums: true,
}

type VoicePermissionDeviceConfigKeys = {
  camel: 'voiceChangeSettings' | 'voiceUseScenes' | 'voiceCreateScenes' | 'voiceUseAlbums'
  snake: 'voice_change_settings' | 'voice_use_scenes' | 'voice_create_scenes' | 'voice_use_albums'
}

/** The backend's spelling: camelCase first, the snake_case twin a USB provisioning might have left. */
export const VOICE_PERMISSION_DEVICE_CONFIG_KEYS: Record<VoicePermissionKey, VoicePermissionDeviceConfigKeys> = {
  change_settings: { camel: 'voiceChangeSettings', snake: 'voice_change_settings' },
  use_scenes: { camel: 'voiceUseScenes', snake: 'voice_use_scenes' },
  create_scenes: { camel: 'voiceCreateScenes', snake: 'voice_create_scenes' },
  use_albums: { camel: 'voiceUseAlbums', snake: 'voice_use_albums' },
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

// ----------------------------------------------------------- the microphone
//
// One rule for the pins field's placeholders, the voice chat controls and
// the "Voice chat" button action: the EFFECTIVE microphone pins are the
// configured ones where set, the board's own where not, and a frame has a
// microphone when the effective clock and data pins are both a GPIO. The
// board's own pins are what a cloud frame reports in its hello
// (`hardware.micClkPin` …, -1 = none) or, nothing reported, what its preset
// carries; a backend frame's are its preset's. No preset with a microphone,
// nothing reported: -1, and nothing to do with voice is drawn.

/** The PDM microphone's clock, data and power GPIO; -1 = none (power: -1 = always powered). */
export type MicrophonePins = { clk: number; data: number; pwr: number }

export const NO_MICROPHONE_PINS: MicrophonePins = { clk: -1, data: -1, pwr: -1 }

/**
 * Boards whose preset carries a PDM microphone (docs/voice-chat.md "Boards"):
 * the reTerminal E1001 and E1002 (clock GPIO42, data GPIO41, power GPIO38).
 * Mirrors the backend's EMBEDDED_SEEED_RETERMINAL_MIC and fos_board.c's
 * k_mics table; the E1004 and every other preset have none.
 */
export const EMBEDDED_PRESET_MICROPHONE_PINS: Partial<Record<FrameEmbeddedHardwarePreset, MicrophonePins>> = {
  seeed_reterminal_e1001: { clk: 42, data: 41, pwr: 38 },
  seeed_reterminal_e1002: { clk: 42, data: 41, pwr: 38 },
}

export const EMBEDDED_PRESETS_WITH_MICROPHONE: readonly FrameEmbeddedHardwarePreset[] = Object.keys(
  EMBEDDED_PRESET_MICROPHONE_PINS
) as FrameEmbeddedHardwarePreset[]

/** The preset's microphone pins, -1 everywhere for a preset without one (or no preset). */
export function presetMicrophonePins(hardwarePreset: string | null | undefined): MicrophonePins {
  return EMBEDDED_PRESET_MICROPHONE_PINS[(hardwarePreset ?? '') as FrameEmbeddedHardwarePreset] ?? NO_MICROPHONE_PINS
}

type ReportedPins = {
  clk?: number | null | undefined
  data?: number | null | undefined
  pwr?: number | null | undefined
}

/**
 * The board's own pins: what the frame reported (a cloud frame's hello,
 * `hardware.micClkPin` …; a reported -1 is a reported none), the preset's
 * table for a pin it did not report, -1 for the rest.
 */
export function boardMicrophonePins({
  hardwarePreset,
  reported,
}: {
  hardwarePreset?: string | null | undefined
  reported?: ReportedPins | undefined
}): MicrophonePins {
  const preset = presetMicrophonePins(hardwarePreset)
  const pick = (value: number | null | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    clk: pick(reported?.clk, preset.clk),
    data: pick(reported?.data, preset.data),
    pwr: pick(reported?.pwr, preset.pwr),
  }
}

type ConfiguredPins = { clk?: number | undefined; data?: number | undefined; pwr?: number | undefined }

/** The pins the frame runs with: each configured pin where set, the board's own where not. */
export function effectiveMicrophonePins(configured: ConfiguredPins, board: MicrophonePins): MicrophonePins {
  return {
    clk: configured.clk ?? board.clk,
    data: configured.data ?? board.data,
    pwr: configured.pwr ?? board.pwr,
  }
}

/** Whether these pins name a microphone: a clock and a data line, both a GPIO. */
export function microphonePinsNameOne(pins: MicrophonePins): boolean {
  return pins.clk >= 0 && pins.data >= 0
}

/** The configured pins of a backend frame's device_config, either spelling (camelCase wins). */
export function configuredMicrophonePinsOf(deviceConfig: DeviceConfig | null | undefined): ConfiguredPins {
  return {
    clk: deviceConfig?.micClkPin ?? deviceConfig?.mic_clk_pin,
    data: deviceConfig?.micDataPin ?? deviceConfig?.mic_data_pin,
    pwr: deviceConfig?.micPwrPin ?? deviceConfig?.mic_pwr_pin,
  }
}

/** What an empty pin field means, spelled out: the board's own GPIO, or plainly -1 when the board has none. */
export function microphonePinPlaceholder(boardPin: number): string {
  return boardPin >= 0 ? `${boardPin} (board default)` : '-1'
}

/**
 * A backend-managed ESP32 frame has a microphone when its effective pins
 * (device_config over the preset's own) name one. Virtual frames and Picos
 * never do; the caller keeps those out.
 */
export function backendFrameHasMicrophone(
  deviceConfig: DeviceConfig | null | undefined,
  hardwarePreset: FrameEmbeddedHardwarePreset | string | null | undefined
): boolean {
  return microphonePinsNameOne(
    effectiveMicrophonePins(configuredMicrophonePinsOf(deviceConfig), boardMicrophonePins({ hardwarePreset }))
  )
}

/**
 * A cloud-managed ESP32 frame has a microphone when its effective pins (the
 * form's over what it reported, over its reported preset's own) name one.
 */
export function cloudFrameHasMicrophone(
  hardware: FrameType['hardware'] | null | undefined,
  form: { mic_clk_pin?: number; mic_data_pin?: number; mic_pwr_pin?: number }
): boolean {
  return microphonePinsNameOne(
    effectiveMicrophonePins(
      { clk: form.mic_clk_pin, data: form.mic_data_pin, pwr: form.mic_pwr_pin },
      boardMicrophonePins({
        hardwarePreset: hardware?.hardwarePreset,
        reported: { clk: hardware?.micClkPin, data: hardware?.micDataPin, pwr: hardware?.micPwrPin },
      })
    )
  )
}
