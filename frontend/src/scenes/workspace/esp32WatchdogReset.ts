/**
 * Post-flash reset via the ESP32-S3's RTC watchdog, like
 * `esptool --after watchdog-reset`.
 *
 * A DTR/RTS reset pulse goes through the USB-Serial/JTAG strap logic, which on
 * some boards (XIAO ESP32-S3) latches the chip back into ROM download mode so
 * the app never boots after flashing (arduino-esp32#6762). The watchdog reset
 * runs over the flasher-stub protocol and never touches the strap pins.
 *
 * Deliberately a leaf module with no imports: it is shared by the workspace
 * flashers (EmbeddedWebFlasher, EmbeddedUsbFirmwareUpdate) and the cloud
 * enrollment flasher (cloud-frontend/src/components/Esp32CloudFlasher.tsx),
 * and it must stay importable from every bundle — including the on-device
 * frame_web build — without dragging in kea models or esptool-js itself.
 */

// ESP32-S3 RTC_CNTL registers, values from esptool's targets/esp32s3.py
const S3_RTC_CNTL_OPTION1_REG = 0x6000812c
const S3_RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK = 0x1
const S3_RTC_CNTL_WDTCONFIG0_REG = 0x60008098
const S3_RTC_CNTL_WDTCONFIG1_REG = 0x6000809c
const S3_RTC_CNTL_WDTWPROTECT_REG = 0x600080b0
const S3_RTC_CNTL_WDT_WKEY = 0x50d83aa1
// WDT_EN | STG0=reset system | sys reset length | cpu reset length
const S3_RTC_WDT_RESET_CONFIG = (0x80000000 | (5 << 28) | (1 << 8) | 2) >>> 0

/** Structural subset of esptool-js's ESPLoader, so callers holding either the
 * real loader or a test stub can pass it without a cast. */
export interface WatchdogResetLoader {
  chip?: { CHIP_NAME?: string } | null
  writeReg(addr: number, value: number, mask?: number): Promise<unknown>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reset the chip via the RTC watchdog. Returns false when the connected chip
 * is not an ESP32-S3 (or arming failed before the point of no return), in
 * which case the caller should fall back to a DTR/RTS pulse. */
export async function watchdogResetAfterFlash(loader: WatchdogResetLoader): Promise<boolean> {
  if (loader.chip?.CHIP_NAME !== 'ESP32-S3') {
    return false
  }
  try {
    await loader.writeReg(S3_RTC_CNTL_OPTION1_REG, 0, S3_RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK)
    await loader.writeReg(S3_RTC_CNTL_WDTWPROTECT_REG, S3_RTC_CNTL_WDT_WKEY)
    await loader.writeReg(S3_RTC_CNTL_WDTCONFIG1_REG, 2000)
  } catch (error) {
    return false
  }
  // The watchdog fires ~20ms after the arming write — often before the
  // arming or lock command's response makes it back, dropping the USB
  // device mid-exchange. Errors from here on mean the reset happened,
  // which is the success case.
  try {
    await loader.writeReg(S3_RTC_CNTL_WDTCONFIG0_REG, S3_RTC_WDT_RESET_CONFIG)
    await loader.writeReg(S3_RTC_CNTL_WDTWPROTECT_REG, 0)
  } catch (error) {}
  await sleep(500)
  return true
}
