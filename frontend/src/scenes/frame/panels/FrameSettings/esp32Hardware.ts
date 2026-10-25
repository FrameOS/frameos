/**
 * ESP32 board tables: the pin layouts, hardware presets and SD-card wiring the
 * Device settings section offers, plus the normalisers that read a stored
 * `device_config` back into them.
 *
 * Pure data and pure functions — no React, no kea. Split out of
 * FrameSettings.tsx so the panel's surface gating (frameSettingsSurface.ts)
 * can be read without scrolling past six hundred lines of GPIO numbers.
 */
import type { Option } from '../../../../components/Select'
import {
  EMBEDDED_ESP32_C3,
  EMBEDDED_ESP32_S3,
  EMBEDDED_PICO_2W,
  EMBEDDED_PICO_W,
  isThinClientEmbeddedPlatform,
} from '../../../../devices'
import type { FrameEmbeddedFlashSize, FrameEmbeddedHardwarePreset, FrameType, GPIOButton } from '../../../../types'

/** The default HTTP response ceiling for a full host OS (64 MiB). */
export const DEFAULT_MAX_HTTP_RESPONSE_BYTES = 64 * 1024 * 1024
/** The default HTTP response ceiling on an embedded board (4 MiB). */
export const EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024

export const ESP32_FLASH_SIZE_OPTIONS: Option[] = [
  { value: '2MB', label: '2MB (Pico W, no OTA)' },
  { value: '4MB', label: '4MB (no OTA)' },
  { value: '8MB', label: '8MB' },
  { value: '16MB', label: '16MB' },
  { value: '32MB', label: '32MB' },
]

export type Esp32Pins = NonNullable<NonNullable<FrameType['device_config']>['pins']>
export type Esp32PinKey = 'rst' | 'dc' | 'cs' | 'cs2' | 'busy' | 'sck' | 'mosi' | 'pwr'
export type Esp32PinLayout = Record<Esp32PinKey, number>
export type Esp32SdCardAssets = NonNullable<NonNullable<FrameType['device_config']>['sdCardAssets']>
export type Esp32SdCardPinKey = 'cs' | 'sck' | 'miso' | 'mosi' | 'pwr' | 'det'
export type Esp32SdCardPinLayout = Record<Esp32SdCardPinKey, number>
export type NormalizedEsp32SdCardAssets = {
  enabled: boolean
  preset: NonNullable<Esp32SdCardAssets['preset']>
  pins: Esp32SdCardPinLayout
  maxFrequencyKHz: number
  mountPath: string
}

export const ESP32_PIN_FIELDS: { key: Esp32PinKey; label: string }[] = [
  { key: 'rst', label: 'RST' },
  { key: 'dc', label: 'DC' },
  { key: 'cs', label: 'CS' },
  { key: 'cs2', label: 'CS2' },
  { key: 'busy', label: 'BUSY' },
  { key: 'sck', label: 'SCK' },
  { key: 'mosi', label: 'MOSI' },
  { key: 'pwr', label: 'PWR' },
]

// The IT8951 (EPD_10in3: the Waveshare 10.3" HAT, the reTerminal E1003) has
// no D/C line and answers the host: the firmware reads its dc slot as the
// controller's MISO, cs2 as the controller's power switch and pwr as the
// panel's (embedded/esp32/components/frameos_display/it8951.c).
const ESP32_IT8951_PIN_LABELS: Partial<Record<Esp32PinKey, string>> = {
  dc: 'MISO',
  cs2: 'CTRL PWR',
  pwr: 'PANEL PWR',
}

/** The pin editor's fields, named for what the panel's driver does with each. */
export function esp32PinFields(device?: string): { key: Esp32PinKey; label: string }[] {
  if (device !== 'waveshare.EPD_10in3') {
    return ESP32_PIN_FIELDS
  }
  return ESP32_PIN_FIELDS.map((field) => ({ ...field, label: ESP32_IT8951_PIN_LABELS[field.key] ?? field.label }))
}

export const ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET: FrameEmbeddedHardwarePreset = 'waveshare_esp32_s3_epaper_13_3e6'
export const ESP32_WAVESHARE_13IN3E6_DEVICE = 'waveshare.EPD_13in3e'
export const ESP32_WAVESHARE_PHOTOPAINTER_HARDWARE_PRESET: FrameEmbeddedHardwarePreset =
  'waveshare_esp32_s3_photopainter'
export const ESP32_WAVESHARE_PHOTOPAINTER_DEVICE = 'waveshare.EPD_7in3e'
// The Inky button tables live in utils/deviceGpioButtons.ts (import-light for
// the cloud typecheck); re-exported for the settings panel's callers.
export {
  INKY_13_AUTO_BUTTON_DEVICES,
  INKY_13_GPIO_BUTTONS,
  INKY_AUTO_BUTTON_DEVICES,
  INKY_GPIO_BUTTONS,
  configuredGpioButtonsForDevice,
} from '../../../../utils/deviceGpioButtons'

export const ESP32_XIAO_PIN_LAYOUT: Esp32PinLayout = {
  rst: 5,
  dc: 4,
  cs: 3,
  cs2: -1,
  busy: 6,
  sck: 7,
  mosi: 9,
  pwr: -1,
}

export const ESP32_XIAO_13IN3E_PIN_LAYOUT: Esp32PinLayout = {
  ...ESP32_XIAO_PIN_LAYOUT,
  cs2: 8,
}

export const ESP32_WAVESHARE_PHOTOPAINTER_PIN_LAYOUT: Esp32PinLayout = {
  rst: 12,
  dc: 8,
  cs: 9,
  cs2: -1,
  busy: 13,
  sck: 10,
  mosi: 11,
  pwr: -1,
}

export const ESP32_WAVESHARE_13IN3E6_PIN_LAYOUT: Esp32PinLayout = {
  rst: 2,
  dc: 11,
  cs: 10,
  cs2: 3,
  busy: 12,
  sck: 9,
  mosi: 46,
  pwr: 1,
}

// Mirrors EMBEDDED_TRMNL_OG_PINS and friends in backend/app/tasks/embedded_firmware.py
export const ESP32_TRMNL_OG_PIN_LAYOUT: Esp32PinLayout = {
  rst: 10,
  dc: 5,
  cs: 6,
  cs2: -1,
  busy: 4,
  sck: 7,
  mosi: 8,
  pwr: -1,
}

export const ESP32_XIAO_EPAPER_DRIVER_BOARD_PIN_LAYOUT: Esp32PinLayout = {
  rst: 38,
  dc: 10,
  cs: 44,
  cs2: -1,
  busy: 4,
  sck: 7,
  mosi: 9,
  pwr: -1,
}

export const ESP32_C3_042_OLED_PIN_LAYOUT: Esp32PinLayout = {
  rst: -1,
  dc: -1,
  cs: -1,
  cs2: -1,
  busy: -1,
  sck: 6,
  mosi: 5,
  pwr: -1,
}
// The Seeed SenseCAP Indicator's LCD is wired by the firmware's own board
// table (lcd_st7701s_rgb.c): the EPD pin slots carry nothing. Mirrors
// EMBEDDED_SEEED_SENSECAP_INDICATOR_PINS.
export const ESP32_SEEED_SENSECAP_INDICATOR_PIN_LAYOUT: Esp32PinLayout = {
  rst: -1,
  dc: -1,
  cs: -1,
  cs2: -1,
  busy: -1,
  sck: -1,
  mosi: -1,
  pwr: -1,
}
export const ESP32_XTEINK_X4_PIN_LAYOUT: Esp32PinLayout = {
  rst: 5,
  dc: 4,
  cs: 21,
  cs2: -1,
  busy: 6,
  sck: 8,
  mosi: 10,
  pwr: -1,
}

export const ESP32_SEEED_RETERMINAL_STICKY_PIN_LAYOUT: Esp32PinLayout = {
  rst: 17,
  dc: 16,
  cs: 15,
  cs2: -1,
  busy: 18,
  sck: 13,
  mosi: 14,
  pwr: 47,
}

export const ESP32_SEEED_RETERMINAL_E10XX_PIN_LAYOUT: Esp32PinLayout = {
  rst: 12,
  dc: 11,
  cs: 10,
  cs2: -1,
  busy: 13,
  sck: 7,
  mosi: 9,
  pwr: -1,
}

// The reTerminal E1003's IT8951 has no D/C line: for its panel (EPD_10in3)
// the dc slot carries the controller's MISO (GPIO8, the TF socket's), pwr the
// panel's power switch and cs2 the controller's (EMBEDDED_SEEED_RETERMINAL_E1003_PINS).
export const ESP32_SEEED_RETERMINAL_E1003_PIN_LAYOUT: Esp32PinLayout = {
  rst: 12,
  dc: 8,
  cs: 10,
  cs2: 21,
  busy: 13,
  sck: 7,
  mosi: 9,
  pwr: 11,
}

export const ESP32_SEEED_RETERMINAL_E1004_PIN_LAYOUT: Esp32PinLayout = {
  rst: 38,
  dc: 11,
  cs: 10,
  cs2: 2,
  busy: 13,
  sck: 7,
  mosi: 9,
  pwr: 12,
}

export const ESP32_ELECROW_CROWPANEL_5IN79_PIN_LAYOUT: Esp32PinLayout = {
  rst: 47,
  dc: 46,
  cs: 45,
  cs2: -1,
  busy: 48,
  sck: 12,
  mosi: 11,
  pwr: -1,
}

// The Inky Frame carrier's wiring beyond the eight ESP32-vocabulary keys: BUSY
// and the five front buttons sit behind a shift register (clock/latch/data,
// BUSY on bit 7), and HOLD_VSYS keeps the regulator on while running from
// battery. Only the pico firmware reads them.
export type InkyFrameExtraPinKey = 'sr_clock' | 'sr_latch' | 'sr_data' | 'busy_bit' | 'hold_vsys'
export type InkyFrameExtraPins = Record<InkyFrameExtraPinKey, number>

export const INKY_FRAME_EXTRA_PIN_FIELDS: { key: InkyFrameExtraPinKey; label: string }[] = [
  { key: 'sr_clock', label: 'SR CLOCK' },
  { key: 'sr_latch', label: 'SR LATCH' },
  { key: 'sr_data', label: 'SR DATA' },
  { key: 'busy_bit', label: 'BUSY bit' },
  { key: 'hold_vsys', label: 'HOLD VSYS' },
]

// Mirrors EMBEDDED_INKY_FRAME_PINS in backend/app/tasks/embedded_firmware.py
// (and INKY_FRAME_PINS in NewFrame.tsx), extras included: a layout that left
// them out made a trip through Frame settings strip the shift-register wiring
// the backend had stored in device_config.pins. BUSY sits behind that shift
// register, so the GPIO is -1 here.
export const PIMORONI_INKY_FRAME_PIN_LAYOUT: Esp32PinLayout & InkyFrameExtraPins = {
  rst: 27,
  dc: 28,
  cs: 17,
  cs2: -1,
  busy: -1,
  sck: 18,
  mosi: 19,
  pwr: -1,
  sr_clock: 8,
  sr_latch: 9,
  sr_data: 10,
  busy_bit: 7,
  hold_vsys: 2,
}

// The four bus pins, then the slot's power switch and card-detect contact
// (-1 = not wired; the firmware drives the switch high before the mount and
// skips the probe when the contact says the slot is empty).
export const ESP32_SD_CARD_PIN_FIELDS: { key: Esp32SdCardPinKey; label: string }[] = [
  { key: 'cs', label: 'CS' },
  { key: 'sck', label: 'SCK' },
  { key: 'miso', label: 'MISO' },
  { key: 'mosi', label: 'MOSI' },
  { key: 'pwr', label: 'Power switch' },
  { key: 'det', label: 'Card detect' },
]

export const ESP32_SD_CARD_EMPTY_PIN_LAYOUT: Esp32SdCardPinLayout = {
  cs: -1,
  sck: -1,
  miso: -1,
  mosi: -1,
  pwr: -1,
  det: -1,
}

export const ESP32_PHOTOPAINTER_SD_CARD_PIN_LAYOUT: Esp32SdCardPinLayout = {
  cs: 38,
  sck: 39,
  miso: 40,
  mosi: 41,
  pwr: -1,
  det: -1,
}

export const ESP32_WAVESHARE_13IN3E6_SD_CARD_PIN_LAYOUT: Esp32SdCardPinLayout = {
  cs: 15,
  sck: 6,
  miso: 5,
  mosi: 7,
  pwr: -1,
  det: -1,
}

// The Seeed reTerminal E1001/E1002/E1004 TF socket (the same on all three):
// it hangs off the panel's SPI bus — SCK7 and MOSI9 are the panel's, which
// is how the firmware knows to share the display bus — with MISO on GPIO8,
// CS on GPIO14, a card-detect contact on GPIO15 and a power switch on
// GPIO16. Mirrors EMBEDDED_SEEED_RETERMINAL_SD_CARD_PINS.
export const ESP32_SEEED_RETERMINAL_SD_CARD_PIN_LAYOUT: Esp32SdCardPinLayout = {
  cs: 14,
  sck: 7,
  miso: 8,
  mosi: 9,
  pwr: 16,
  det: 15,
}

// The E1003's socket switches its power on GPIO39 (its GPIO16 is the LED).
export const ESP32_SEEED_RETERMINAL_E1003_SD_CARD_PIN_LAYOUT: Esp32SdCardPinLayout = {
  ...ESP32_SEEED_RETERMINAL_SD_CARD_PIN_LAYOUT,
  pwr: 39,
}

// The reTerminal Sticky's socket, on its panel's SCK13/MOSI14 with MISO on
// GPIO12, CS on GPIO8, a power switch on GPIO10 and the card-detect contact
// on GPIO11 (SPI mode only). Mirrors EMBEDDED_SEEED_STICKY_SD_CARD_PINS.
export const ESP32_SEEED_STICKY_SD_CARD_PIN_LAYOUT: Esp32SdCardPinLayout = {
  cs: 8,
  sck: 13,
  miso: 12,
  mosi: 14,
  pwr: 10,
  det: 11,
}

export const ESP32_SEEED_RETERMINAL_SD_CARD_PRESETS = [
  'seeed_reterminal_sticky',
  'seeed_reterminal_e1001',
  'seeed_reterminal_e1002',
  'seeed_reterminal_e1003',
  'seeed_reterminal_e1004',
] as const
export type Esp32SeeedReterminalSdCardPreset = (typeof ESP32_SEEED_RETERMINAL_SD_CARD_PRESETS)[number]

export function isSeeedReterminalSdCardPreset(value: unknown): value is Esp32SeeedReterminalSdCardPreset {
  return (ESP32_SEEED_RETERMINAL_SD_CARD_PRESETS as readonly unknown[]).includes(value)
}

export interface Esp32HardwarePresetConfig {
  label: string
  platform: string
  device: string
  flashSize: FrameEmbeddedFlashSize
  psramMB: number
  /** The Inky Frame presets carry their shift-register keys here too; every
   * copy below is a spread, so they survive into device_config.pins. */
  pins: Esp32PinLayout & Partial<InkyFrameExtraPins>
  sdCardAssets?: Esp32SdCardAssets
}

// Mirrors EMBEDDED_HARDWARE_PRESETS in backend/app/tasks/embedded_firmware.py
export const ESP32_HARDWARE_PRESET_CONFIGS: Partial<Record<FrameEmbeddedHardwarePreset, Esp32HardwarePresetConfig>> = {
  [ESP32_WAVESHARE_PHOTOPAINTER_HARDWARE_PRESET]: {
    label: 'Waveshare ESP32-S3 PhotoPainter',
    platform: EMBEDDED_ESP32_S3,
    device: ESP32_WAVESHARE_PHOTOPAINTER_DEVICE,
    flashSize: '16MB',
    psramMB: 8,
    pins: ESP32_WAVESHARE_PHOTOPAINTER_PIN_LAYOUT,
    sdCardAssets: {
      enabled: true,
      preset: ESP32_WAVESHARE_PHOTOPAINTER_HARDWARE_PRESET,
      pins: ESP32_PHOTOPAINTER_SD_CARD_PIN_LAYOUT,
      maxFrequencyKHz: 20000,
      mountPath: '/srv/assets',
    },
  },
  [ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET]: {
    label: 'Waveshare ESP32-S3 ePaper 13.3E6',
    platform: EMBEDDED_ESP32_S3,
    device: ESP32_WAVESHARE_13IN3E6_DEVICE,
    flashSize: '32MB',
    psramMB: 16,
    pins: ESP32_WAVESHARE_13IN3E6_PIN_LAYOUT,
    sdCardAssets: {
      enabled: true,
      preset: ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET,
      pins: ESP32_WAVESHARE_13IN3E6_SD_CARD_PIN_LAYOUT,
      maxFrequencyKHz: 20000,
      mountPath: '/srv/assets',
    },
  },
  trmnl_og: {
    label: 'TRMNL OG (7.5" ESP32-C3)',
    platform: EMBEDDED_ESP32_C3,
    device: 'waveshare.EPD_7in5_V2',
    flashSize: '4MB',
    psramMB: 0,
    pins: ESP32_TRMNL_OG_PIN_LAYOUT,
  },
  trmnl_bwry: {
    label: 'TRMNL BWRY (7.5" color ESP32-C3)',
    platform: EMBEDDED_ESP32_C3,
    device: 'waveshare.EPD_7in5yr',
    flashSize: '4MB',
    psramMB: 0,
    pins: ESP32_TRMNL_OG_PIN_LAYOUT,
  },
  trmnl_og_diy_kit: {
    label: 'TRMNL 7.5" DIY Kit (XIAO ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_7in5_V2',
    flashSize: '8MB',
    psramMB: 8,
    pins: ESP32_XIAO_EPAPER_DRIVER_BOARD_PIN_LAYOUT,
  },
  trmnl_4in26_diy_kit: {
    label: 'TRMNL 4.26" DIY Kit (XIAO ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_4in26',
    flashSize: '8MB',
    psramMB: 8,
    pins: ESP32_XIAO_EPAPER_DRIVER_BOARD_PIN_LAYOUT,
  },
  xteink_x4: {
    label: 'XTEINK X4 (4.26" ESP32-C3)',
    platform: EMBEDDED_ESP32_C3,
    device: 'waveshare.EPD_4in26',
    flashSize: '16MB',
    psramMB: 0,
    pins: ESP32_XTEINK_X4_PIN_LAYOUT,
  },
  esp32_c3_042_oled: {
    label: 'ESP32-C3 0.42" OLED dev board (I2C, thin client)',
    platform: EMBEDDED_ESP32_C3,
    device: 'oled.ssd1306_72x40',
    flashSize: '4MB',
    psramMB: 0,
    pins: ESP32_C3_042_OLED_PIN_LAYOUT,
  },
  seeed_sensecap_indicator_d1: {
    label: 'Seeed SenseCAP Indicator D1/D1S (4" LCD ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'lcd.st7701s_480x480',
    flashSize: '8MB',
    psramMB: 8,
    pins: ESP32_SEEED_SENSECAP_INDICATOR_PIN_LAYOUT,
  },
  seeed_reterminal_sticky: {
    label: 'Seeed reTerminal Sticky (3.97" ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_3in97',
    flashSize: '32MB',
    psramMB: 8,
    pins: ESP32_SEEED_RETERMINAL_STICKY_PIN_LAYOUT,
    sdCardAssets: {
      enabled: true,
      preset: 'seeed_reterminal_sticky',
      pins: ESP32_SEEED_STICKY_SD_CARD_PIN_LAYOUT,
      maxFrequencyKHz: 20000,
      mountPath: '/srv/assets',
    },
  },
  seeed_reterminal_e1001: {
    label: 'Seeed reTerminal E1001 (7.5" ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_7in5_V2',
    flashSize: '32MB',
    psramMB: 8,
    pins: ESP32_SEEED_RETERMINAL_E10XX_PIN_LAYOUT,
    sdCardAssets: {
      enabled: true,
      preset: 'seeed_reterminal_e1001',
      pins: ESP32_SEEED_RETERMINAL_SD_CARD_PIN_LAYOUT,
      maxFrequencyKHz: 20000,
      mountPath: '/srv/assets',
    },
  },
  seeed_reterminal_e1002: {
    label: 'Seeed reTerminal E1002 (7.3" color ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_7in3e',
    flashSize: '32MB',
    psramMB: 8,
    pins: ESP32_SEEED_RETERMINAL_E10XX_PIN_LAYOUT,
    sdCardAssets: {
      enabled: true,
      preset: 'seeed_reterminal_e1002',
      pins: ESP32_SEEED_RETERMINAL_SD_CARD_PIN_LAYOUT,
      maxFrequencyKHz: 20000,
      mountPath: '/srv/assets',
    },
  },
  seeed_reterminal_e1003: {
    label: 'Seeed reTerminal E1003 (10.3" grayscale ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_10in3',
    flashSize: '32MB',
    psramMB: 8,
    pins: ESP32_SEEED_RETERMINAL_E1003_PIN_LAYOUT,
    sdCardAssets: {
      enabled: true,
      preset: 'seeed_reterminal_e1003',
      pins: ESP32_SEEED_RETERMINAL_E1003_SD_CARD_PIN_LAYOUT,
      maxFrequencyKHz: 20000,
      mountPath: '/srv/assets',
    },
  },
  seeed_reterminal_e1004: {
    label: 'Seeed reTerminal E1004 (13.3" color ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_13in3e',
    flashSize: '32MB',
    psramMB: 8,
    pins: ESP32_SEEED_RETERMINAL_E1004_PIN_LAYOUT,
    sdCardAssets: {
      enabled: true,
      preset: 'seeed_reterminal_e1004',
      pins: ESP32_SEEED_RETERMINAL_SD_CARD_PIN_LAYOUT,
      maxFrequencyKHz: 20000,
      mountPath: '/srv/assets',
    },
  },
  elecrow_crowpanel_5in79: {
    label: 'Elecrow CrowPanel 5.79" (ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_5in79',
    flashSize: '8MB',
    psramMB: 8,
    pins: ESP32_ELECROW_CROWPANEL_5IN79_PIN_LAYOUT,
  },
  // Pimoroni Inky Frame family: pico platforms flash a generic UF2 over
  // BOOTSEL and are provisioned via USB serial — the backend never builds
  // per-frame firmware for them.
  pimoroni_inky_frame_4: {
    label: 'Pimoroni Inky Frame 4.0" (Pico W)',
    platform: EMBEDDED_PICO_W,
    device: 'waveshare.EPD_4in01f',
    flashSize: '2MB',
    psramMB: 0,
    pins: PIMORONI_INKY_FRAME_PIN_LAYOUT,
  },
  pimoroni_inky_frame_5_7: {
    label: 'Pimoroni Inky Frame 5.7" (Pico W)',
    platform: EMBEDDED_PICO_W,
    device: 'waveshare.EPD_5in65f',
    flashSize: '2MB',
    psramMB: 0,
    pins: PIMORONI_INKY_FRAME_PIN_LAYOUT,
  },
  pimoroni_inky_frame_7_3: {
    label: 'Pimoroni Inky Frame 7.3" (Pico W)',
    platform: EMBEDDED_PICO_W,
    device: 'waveshare.EPD_7in3f',
    flashSize: '2MB',
    psramMB: 0,
    pins: PIMORONI_INKY_FRAME_PIN_LAYOUT,
  },
  pimoroni_inky_frame_7_3_pico2: {
    label: 'Pimoroni Inky Frame 7.3" (Pico 2 W, 2024)',
    platform: EMBEDDED_PICO_2W,
    device: 'waveshare.EPD_7in3f',
    flashSize: '4MB',
    psramMB: 0,
    pins: PIMORONI_INKY_FRAME_PIN_LAYOUT,
  },
  pimoroni_inky_frame_7_3_spectra: {
    label: 'Pimoroni Inky Frame 7.3" Spectra 6 (Pico 2 W)',
    platform: EMBEDDED_PICO_2W,
    device: 'waveshare.EPD_7in3e',
    flashSize: '4MB',
    psramMB: 0,
    pins: PIMORONI_INKY_FRAME_PIN_LAYOUT,
  },
}

export const ESP32_HARDWARE_PRESET_OPTIONS: Option[] = [
  { value: 'custom', label: 'Custom board' },
  ...Object.entries(ESP32_HARDWARE_PRESET_CONFIGS).map(([value, config]) => ({
    value,
    // Boards without PSRAM cannot render on-device; flag them so it is clear
    // the backend does the rendering for these presets.
    label: isThinClientEmbeddedPlatform(config.platform) ? `${config.label} — Thin client` : config.label,
  })),
]

export function normalizeEsp32HardwarePreset(value: unknown): FrameEmbeddedHardwarePreset {
  if (typeof value === 'string' && value in ESP32_HARDWARE_PRESET_CONFIGS) {
    return value as FrameEmbeddedHardwarePreset
  }
  return 'custom'
}

export function esp32HardwarePresetConfig(
  hardwarePreset: FrameEmbeddedHardwarePreset
): Esp32HardwarePresetConfig | null {
  const config = ESP32_HARDWARE_PRESET_CONFIGS[hardwarePreset]
  if (!config) {
    return null
  }
  return {
    ...config,
    pins: { ...config.pins },
    sdCardAssets: config.sdCardAssets
      ? { ...config.sdCardAssets, pins: { ...(config.sdCardAssets.pins ?? {}) } }
      : undefined,
  }
}

export function esp32RecommendedPinLayout(
  device?: string,
  hardwarePreset?: FrameEmbeddedHardwarePreset | string
): Esp32PinLayout {
  const presetConfig = esp32HardwarePresetConfig(normalizeEsp32HardwarePreset(hardwarePreset))
  if (presetConfig) {
    return { ...presetConfig.pins }
  }
  return device === ESP32_WAVESHARE_13IN3E6_DEVICE ? { ...ESP32_XIAO_13IN3E_PIN_LAYOUT } : { ...ESP32_XIAO_PIN_LAYOUT }
}

export function normalizeEsp32PinNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(-1, Math.min(48, Math.round(value)))
}

export function normalizeEsp32SdCardFrequency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 20000
  }
  return Math.max(400, Math.min(40000, Math.round(value)))
}

export function normalizeEsp32SdCardPinLayout(
  value: Partial<Esp32SdCardPinLayout> | undefined,
  fallback: Esp32SdCardPinLayout = ESP32_SD_CARD_EMPTY_PIN_LAYOUT
): Esp32SdCardPinLayout {
  return {
    cs: normalizeEsp32PinNumber(value?.cs, fallback.cs),
    sck: normalizeEsp32PinNumber(value?.sck, fallback.sck),
    miso: normalizeEsp32PinNumber(value?.miso, fallback.miso),
    mosi: normalizeEsp32PinNumber(value?.mosi, fallback.mosi),
    pwr: normalizeEsp32PinNumber(value?.pwr, fallback.pwr),
    det: normalizeEsp32PinNumber(value?.det, fallback.det),
  }
}

export function normalizeEsp32SdCardAssets(value: Esp32SdCardAssets | undefined): NormalizedEsp32SdCardAssets {
  const preset =
    value?.preset === 'waveshare_esp32_s3_photopainter' ||
    value?.preset === ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET ||
    isSeeedReterminalSdCardPreset(value?.preset)
      ? value.preset
      : 'custom'
  const presetPins = esp32SdCardPinsForPreset(preset)
  return {
    enabled: value?.enabled === true,
    preset,
    pins: normalizeEsp32SdCardPinLayout(value?.pins, presetPins),
    maxFrequencyKHz: normalizeEsp32SdCardFrequency(value?.maxFrequencyKHz),
    mountPath: '/srv/assets',
  }
}

export function esp32SdCardPinLayoutsEqual(first: Esp32SdCardPinLayout, second: Esp32SdCardPinLayout): boolean {
  return ESP32_SD_CARD_PIN_FIELDS.every(({ key }) => first[key] === second[key])
}

/**
 * The SD preset select's value for a config: its stored preset when it is a
 * known socket, else the socket whose pins it matches, else custom. Three
 * reTerminal E-series share one socket, so pins matching it name
 * `seeedPreset` (the frame's own E-series preset, when it is one) rather
 * than a fixed member of the three. The Sticky's and the E1003's sockets are
 * their own.
 */
export function esp32SdCardPresetValue(
  config: NormalizedEsp32SdCardAssets,
  seeedPreset: Esp32SeeedReterminalSdCardPreset = 'seeed_reterminal_e1002'
): string {
  if (config.preset === 'waveshare_esp32_s3_photopainter') {
    return 'waveshare_esp32_s3_photopainter'
  }
  if (config.preset === ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET) {
    return ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET
  }
  // The Sticky's and the E1003's sockets are their own; three E-series share one.
  if (config.preset === 'seeed_reterminal_sticky' || config.preset === 'seeed_reterminal_e1003') {
    return config.preset
  }
  const eSeriesPreset =
    seeedPreset === 'seeed_reterminal_sticky' || seeedPreset === 'seeed_reterminal_e1003'
      ? 'seeed_reterminal_e1002'
      : seeedPreset
  if (isSeeedReterminalSdCardPreset(config.preset)) {
    return eSeriesPreset
  }
  if (esp32SdCardPinLayoutsEqual(config.pins, ESP32_PHOTOPAINTER_SD_CARD_PIN_LAYOUT)) {
    return 'waveshare_esp32_s3_photopainter'
  }
  if (esp32SdCardPinLayoutsEqual(config.pins, ESP32_WAVESHARE_13IN3E6_SD_CARD_PIN_LAYOUT)) {
    return ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET
  }
  if (esp32SdCardPinLayoutsEqual(config.pins, ESP32_SEEED_STICKY_SD_CARD_PIN_LAYOUT)) {
    return 'seeed_reterminal_sticky'
  }
  if (esp32SdCardPinLayoutsEqual(config.pins, ESP32_SEEED_RETERMINAL_E1003_SD_CARD_PIN_LAYOUT)) {
    return 'seeed_reterminal_e1003'
  }
  if (esp32SdCardPinLayoutsEqual(config.pins, ESP32_SEEED_RETERMINAL_SD_CARD_PIN_LAYOUT)) {
    return eSeriesPreset
  }
  return 'custom'
}

export function esp32SdCardPinsForPreset(preset: string): Esp32SdCardPinLayout {
  if (preset === 'waveshare_esp32_s3_photopainter') {
    return { ...ESP32_PHOTOPAINTER_SD_CARD_PIN_LAYOUT }
  }
  if (preset === ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET) {
    return { ...ESP32_WAVESHARE_13IN3E6_SD_CARD_PIN_LAYOUT }
  }
  if (preset === 'seeed_reterminal_sticky') {
    return { ...ESP32_SEEED_STICKY_SD_CARD_PIN_LAYOUT }
  }
  if (preset === 'seeed_reterminal_e1003') {
    return { ...ESP32_SEEED_RETERMINAL_E1003_SD_CARD_PIN_LAYOUT }
  }
  if (isSeeedReterminalSdCardPreset(preset)) {
    return { ...ESP32_SEEED_RETERMINAL_SD_CARD_PIN_LAYOUT }
  }
  return { ...ESP32_SD_CARD_EMPTY_PIN_LAYOUT }
}

const ESP32_PIN_LAYOUT_KEYS: ReadonlySet<string> = new Set([...ESP32_PIN_FIELDS.map(({ key }) => key), 'sclk'])

/**
 * Whatever a stored pin map carries beyond the eight keys the ESP32 form
 * edits (and `sclk`, the old spelling of `sck`): today the Inky Frame's
 * shift-register wiring. Kept as found — the form does not own these keys, so
 * it must not be the thing that deletes them.
 */
export function esp32ExtraPins(value: Esp32Pins | undefined): Partial<InkyFrameExtraPins> {
  const extras: Record<string, unknown> = {}
  if (value && typeof value === 'object') {
    for (const [key, pin] of Object.entries(value)) {
      if (!ESP32_PIN_LAYOUT_KEYS.has(key)) {
        extras[key] = pin
      }
    }
  }
  return extras as Partial<InkyFrameExtraPins>
}

export function normalizeEsp32PinLayout(
  value: Esp32Pins | undefined,
  device?: string,
  hardwarePreset?: FrameEmbeddedHardwarePreset | string
): Esp32PinLayout & Partial<InkyFrameExtraPins> {
  const recommended = esp32RecommendedPinLayout(device, hardwarePreset)
  if (!value || typeof value !== 'object') {
    return recommended
  }
  return {
    // Extra keys ride along untouched; an Inky Frame preset also restores the
    // ones an earlier save of this form stripped.
    ...esp32ExtraPins(recommended),
    ...esp32ExtraPins(value),
    rst: normalizeEsp32PinNumber(value.rst, recommended.rst),
    dc: normalizeEsp32PinNumber(value.dc, recommended.dc),
    cs: normalizeEsp32PinNumber(value.cs, recommended.cs),
    cs2: normalizeEsp32PinNumber(value.cs2, recommended.cs2),
    busy: normalizeEsp32PinNumber(value.busy, recommended.busy),
    sck: normalizeEsp32PinNumber(value.sck ?? value.sclk, recommended.sck),
    mosi: normalizeEsp32PinNumber(value.mosi, recommended.mosi),
    pwr: normalizeEsp32PinNumber(value.pwr, recommended.pwr),
  }
}

export function esp32PinLayoutsEqual(first: Esp32PinLayout, second: Esp32PinLayout): boolean {
  return ESP32_PIN_FIELDS.every(({ key }) => first[key] === second[key])
}

export const ESP32_PIN_LAYOUT_PRESETS: { value: string; label: string; pins: Esp32PinLayout }[] = [
  { value: 'xiao', label: 'Seeed XIAO ESP32-S3', pins: ESP32_XIAO_PIN_LAYOUT },
  { value: 'xiao-13in3e', label: 'Seeed XIAO ESP32-S3 + CS2 on GPIO8', pins: ESP32_XIAO_13IN3E_PIN_LAYOUT },
  {
    value: 'waveshare-photopainter',
    label: 'Waveshare ESP32-S3 PhotoPainter',
    pins: ESP32_WAVESHARE_PHOTOPAINTER_PIN_LAYOUT,
  },
  { value: 'waveshare-13in3e6', label: 'Waveshare ESP32-S3 ePaper 13.3E6', pins: ESP32_WAVESHARE_13IN3E6_PIN_LAYOUT },
  { value: 'trmnl-og', label: 'TRMNL OG/BWRY (ESP32-C3)', pins: ESP32_TRMNL_OG_PIN_LAYOUT },
  {
    value: 'xiao-epaper-driver-board',
    label: 'Seeed XIAO ePaper Driver Board (TRMNL DIY Kit)',
    pins: ESP32_XIAO_EPAPER_DRIVER_BOARD_PIN_LAYOUT,
  },
  { value: 'xteink-x4', label: 'XTEINK X4 (ESP32-C3)', pins: ESP32_XTEINK_X4_PIN_LAYOUT },
  {
    value: 'seeed-reterminal-sticky',
    label: 'Seeed reTerminal Sticky',
    pins: ESP32_SEEED_RETERMINAL_STICKY_PIN_LAYOUT,
  },
  {
    value: 'seeed-reterminal-e10xx',
    label: 'Seeed reTerminal E1001/E1002',
    pins: ESP32_SEEED_RETERMINAL_E10XX_PIN_LAYOUT,
  },
  {
    value: 'seeed-reterminal-e1003',
    label: 'Seeed reTerminal E1003 (10.3")',
    pins: ESP32_SEEED_RETERMINAL_E1003_PIN_LAYOUT,
  },
  {
    value: 'seeed-reterminal-e1004',
    label: 'Seeed reTerminal E1004 (13.3")',
    pins: ESP32_SEEED_RETERMINAL_E1004_PIN_LAYOUT,
  },
  {
    value: 'elecrow-crowpanel-5in79',
    label: 'Elecrow CrowPanel 5.79"',
    pins: ESP32_ELECROW_CROWPANEL_5IN79_PIN_LAYOUT,
  },
  {
    value: 'pimoroni-inky-frame',
    label: 'Pimoroni Inky Frame (Pico W / Pico 2 W)',
    pins: PIMORONI_INKY_FRAME_PIN_LAYOUT,
  },
]

export function esp32PinLayoutPresetValue(pins: Esp32PinLayout): string {
  for (const layoutPreset of ESP32_PIN_LAYOUT_PRESETS) {
    if (esp32PinLayoutsEqual(pins, layoutPreset.pins)) {
      return layoutPreset.value
    }
  }
  return 'custom'
}

export function esp32PinLayoutPresetOptions(device?: string): Option[] {
  const options: Option[] = ESP32_PIN_LAYOUT_PRESETS.map(({ value, label }) => ({ value, label }))
  // Float the layout that matches the selected panel's dedicated board to the top
  const preferredValue =
    device === ESP32_WAVESHARE_PHOTOPAINTER_DEVICE
      ? 'waveshare-photopainter'
      : device === ESP32_WAVESHARE_13IN3E6_DEVICE
      ? 'waveshare-13in3e6'
      : null
  if (preferredValue) {
    options.sort((first, second) => (first.value === preferredValue ? -1 : second.value === preferredValue ? 1 : 0))
  }
  return [...options, { value: 'custom', label: 'Custom' }]
}

export function esp32PinLayoutForPreset(
  preset: string,
  device?: string,
  hardwarePreset?: FrameEmbeddedHardwarePreset | string
): Esp32PinLayout | null {
  const layoutPreset = ESP32_PIN_LAYOUT_PRESETS.find(({ value }) => value === preset)
  if (layoutPreset) {
    return { ...layoutPreset.pins }
  }
  if (preset === 'recommended') {
    return esp32RecommendedPinLayout(device, hardwarePreset)
  }
  return null
}
