/**
 * Displays whose ESP32 firmware can set the glass's brightness
 * (fos_display_brightness, embedded/esp32): the round AMOLED's own register
 * (CO5300 0x51) and the backlight PWM of the CrowPanel watch (GC9309) and
 * the CrowPanel 1.46" rotary (ST77961) and the CrowPanel Advance 2.8"
 * (ST7789, its backlight transistor on GPIO38). The frame
 * settings `brightness`, `dim_after_seconds` and `dim_brightness`
 * (docs/cloud-frames-contract.json) show only for these; another display
 * ignores them. By the backend's device key and by the firmware panel key a
 * cloud ESP32 reports as its `hardware.device`.
 */
export const BRIGHTNESS_DEVICES: ReadonlySet<string> = new Set([
  'amoled.co5300_466x466',
  'lcd.gc9309_240x296',
  'lcd.st77961_360x360',
  'lcd.st7789_320x240',
  'AMOLED_CO5300_466x466',
  'LCD_GC9309_240x296',
  'LCD_ST77961_360x360',
  'LCD_ST7789_320x240',
])

export function deviceCanDim(device: string | null | undefined): boolean {
  return !!device && BRIGHTNESS_DEVICES.has(device)
}
