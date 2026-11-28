// Whether a frame has an accelerometer (docs/accelerometer.md): what offers
// its motion gestures in "Button actions" and "Map buttons", and the
// auto-rotate setting. The board says so in its hardware report (`imu`, an
// accelerometer answered at boot); before its first report the board's
// preset does (the two boards FrameOS knows one on). A frame that reported
// none has none, whatever its preset says.
//
// Import-free on purpose: the cloud's node test suite exercises it directly.

/** The ESP32 hardware presets whose board carries an accelerometer (fos_imu.c k_board_axes).
 * Mirrors EMBEDDED_ACCELEROMETER_PRESETS in backend/app/tasks/embedded_firmware.py. */
export const ACCELEROMETER_HARDWARE_PRESETS: readonly string[] = [
  'seeed_reterminal_sticky',
  'waveshare_esp32_s3_touch_amoled_1_75',
]

interface AccelerometerFrame {
  hardware?: { imu?: boolean | null; hardwarePreset?: string | null } | null
  embedded?: { hardwarePreset?: string | null } | null
  device_config?: { hardwarePreset?: string | null } | null
}

export function frameHasAccelerometer(frame: AccelerometerFrame | null | undefined): boolean {
  const reported = frame?.hardware?.imu
  if (reported === true || reported === false) {
    return reported
  }
  const preset =
    frame?.hardware?.hardwarePreset || frame?.embedded?.hardwarePreset || frame?.device_config?.hardwarePreset || ''
  return ACCELEROMETER_HARDWARE_PRESETS.includes(preset)
}
