import type { ClickSounds } from '../types'

/**
 * The sounds of a tap and a press on a frame (`click_sounds`,
 * docs/cloud-frames-contract.json): the touch clicks, the button clicks and the
 * loading chirp, silent or the buzzer's own. Set in the frame's settings on
 * both planes and on the frame page (docs/scene-settings.md), which the planes
 * adopt. More modes may join this list.
 */
export const CLICK_SOUND_OPTIONS: { value: ClickSounds; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'silent', label: 'Silent' },
]

export function clickSoundsOf(value: unknown): ClickSounds {
  return CLICK_SOUND_OPTIONS.some((option) => option.value === value) ? (value as ClickSounds) : 'normal'
}

/** The board presets that make sounds: a buzzer, or the codec's speaker.
 * Mirrors EMBEDDED_SOUND_PRESETS in backend/app/tasks/embedded_firmware.py. */
export const SOUND_HARDWARE_PRESETS: ReadonlySet<string> = new Set([
  'seeed_reterminal_sticky',
  'seeed_reterminal_e1001',
  'seeed_reterminal_e1002',
  'seeed_reterminal_e1003',
  'seeed_reterminal_e1004',
  'waveshare_esp32_s3_photopainter',
  'waveshare_esp32_s3_epaper_13_3e6',
  // Its vibration motor plays the notes.
  'elecrow_crowpanel_watch_2in01',
])

/**
 * Whether a frame makes sounds, so its settings offer the choice: most frames
 * have none. What the frame reports wins (`hardware.sounds`, 2026.11.15+);
 * else its board preset, or a buzzer GPIO someone set.
 */
export function frameHasSounds(facts: {
  reportedSounds?: boolean | null
  hardwarePreset?: string | null
  buzzerPin?: number | null
  reportedBuzzerPin?: number | null
}): boolean {
  if (typeof facts.reportedSounds === 'boolean') {
    return facts.reportedSounds
  }
  if (facts.hardwarePreset && SOUND_HARDWARE_PRESETS.has(facts.hardwarePreset)) {
    return true
  }
  return (facts.buzzerPin ?? facts.reportedBuzzerPin ?? -1) >= 0
}
