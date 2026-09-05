/**
 * Post-flash reset via the ESP32-S3 / ESP32-C3 RTC watchdog, like
 * `esptool --after watchdog-reset`.
 *
 * A DTR/RTS reset pulse goes through the USB-Serial/JTAG strap logic, which on
 * some boards (XIAO ESP32-S3) latches the chip back into ROM download mode so
 * the app never boots after flashing (arduino-esp32#6762). The watchdog reset
 * runs over the flasher-stub protocol and never touches the strap pins.
 *
 * Deliberately a leaf module with no imports: it is shared by the workspace
 * flashers (EmbeddedReleaseFlasher, EmbeddedUsbFirmwareUpdate) and the cloud
 * enrollment flasher (cloud-frontend/src/components/Esp32CloudFlasher.tsx),
 * and it must stay importable from every bundle — including the on-device
 * frame_web build — without dragging in kea models or esptool-js itself.
 */

// RTC_CNTL registers per chip, values from esptool's targets/esp32s3.py and
// esp32c3.py (both RTCCNTL_BASE_REG 0x60008000, the WDT block sits 8 bytes
// lower on the C3). The C3 is USB-Serial/JTAG too and lands in download mode
// off a DTR/RTS pulse the same way (seen on a 4 MB C3 dev board, 2026-09-05:
// the release flasher waited out its whole boot window until a RESET tap), so
// it takes the same watchdog exit. Only the S3 has the RTC_CNTL_OPTION1
// force-download-boot latch esptool clears first; the C3 has no such register.
interface RtcWatchdogRegisters {
  forceDownloadBoot?: { reg: number; mask: number }
  wdtConfig0: number
  wdtConfig1: number
  wdtWriteProtect: number
}

const RTC_WATCHDOG_REGISTERS: Record<string, RtcWatchdogRegisters> = {
  'ESP32-S3': {
    forceDownloadBoot: { reg: 0x6000812c, mask: 0x1 },
    wdtConfig0: 0x60008098,
    wdtConfig1: 0x6000809c,
    wdtWriteProtect: 0x600080b0,
  },
  'ESP32-C3': {
    wdtConfig0: 0x60008090,
    wdtConfig1: 0x60008094,
    wdtWriteProtect: 0x600080a8,
  },
}
const RTC_CNTL_WDT_WKEY = 0x50d83aa1
// WDT_EN | STG0=reset system | sys reset length | cpu reset length
const RTC_WDT_RESET_CONFIG = (0x80000000 | (5 << 28) | (1 << 8) | 2) >>> 0

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
 * has no register table here (or arming failed before the point of no
 * return), in which case the caller should fall back to a DTR/RTS pulse. */
export async function watchdogResetAfterFlash(loader: WatchdogResetLoader): Promise<boolean> {
  const regs = loader.chip?.CHIP_NAME ? RTC_WATCHDOG_REGISTERS[loader.chip.CHIP_NAME] : undefined
  if (!regs) {
    return false
  }
  try {
    if (regs.forceDownloadBoot) {
      await loader.writeReg(regs.forceDownloadBoot.reg, 0, regs.forceDownloadBoot.mask)
    }
    await loader.writeReg(regs.wdtWriteProtect, RTC_CNTL_WDT_WKEY)
    await loader.writeReg(regs.wdtConfig1, 2000)
  } catch (error) {
    return false
  }
  // The watchdog fires ~20ms after the arming write — often before the
  // arming or lock command's response makes it back, dropping the USB
  // device mid-exchange. Errors from here on mean the reset happened,
  // which is the success case.
  try {
    await loader.writeReg(regs.wdtConfig0, RTC_WDT_RESET_CONFIG)
    await loader.writeReg(regs.wdtWriteProtect, 0)
  } catch (error) {}
  await sleep(500)
  return true
}
