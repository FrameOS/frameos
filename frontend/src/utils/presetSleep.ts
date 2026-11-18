/**
 * What a board's preset turns on by itself when it is applied on the device
 * (the console's `preset` in embedded/esp32/main/fos_console.c, and the
 * backend's EMBEDDED_HARDWARE_PRESETS): deep sleep on battery, waking this
 * often for commands.
 *
 * The cloud keeps only what its owner set, so its Power panel drew "Only wake
 * to render" over a frame that woke every 15 minutes, and choosing what the
 * box already showed sent nothing (a reTerminal E1004, 2026-11-18). The device
 * names its preset in every hello (`hardware.hardwarePreset`), so the panel
 * reads the defaults off that: no report of its own from the firmware, and
 * right for frames on firmware from before this was noticed.
 * `test_esp32_animation.py` keeps this list and the firmware's alike.
 */
export const PRESET_WAKE_CHECK_SECONDS: Readonly<Record<string, number>> = {
  seeed_reterminal_sticky: 900,
  seeed_reterminal_e1003: 900,
  seeed_reterminal_e1004: 900,
}

/** Seconds between a preset's wakes for commands; undefined when the preset leaves power alone. */
export function presetWakeCheckSeconds(preset: string | null | undefined): number | undefined {
  return preset ? PRESET_WAKE_CHECK_SECONDS[preset] : undefined
}
