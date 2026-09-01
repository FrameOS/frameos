// Device memory simulation for the preview.
//
// The preview runs the real interpreter, but a browser has effectively
// unlimited memory, so a scene that exhausts an ESP32's PSRAM previews
// perfectly and only fails once it reaches hardware. Picking a device here
// puts the runtime under that device's ceiling: allocations past it are
// refused the way they are on a full frame, and the render comes back as
// `outOfMemory` instead of a picture.
//
// Every number below is either a firmware constant or a measurement off a
// real frame — keep them in step with
// embedded/esp32/components/frameos_display/frameos_display.c,
// components/frameos_nim/frameos_nim_glue.c,
// components/frameos_quickjs/fos_qjs_glue.c and
// frameos/src/frameos/utils/memory.nim.

export interface DeviceLimits {
  /** Ceiling on the runtime's heap, in bytes. 0 = no simulation. */
  memoryBytes: number
  /** Margin the render pipeline keeps below the ceiling when planning
   * decodes (the device's availableRenderBytes reserve). Allocation still
   * succeeds into it. */
  memoryReserveBytes: number
  /** Bytes of the ceiling that exist only because the preview stores images
   * differently from the device (see `esp32PreviewOverheadBytes`). Subtract
   * it from both the ceiling and a measured peak to read them in the
   * device's own bytes — the ones its logs report. */
  previewOverheadBytes: number
  /** QuickJS heap ceiling per scene context, in MB; -1 keeps the host default. */
  jsMemoryLimitMb: number
  /** QuickJS stack ceiling in KB; -1 keeps the host default. */
  jsMaxStackKb: number
  /** HTTP response cap in bytes; 0 keeps the host default. */
  maxHttpResponseBytes: number
}

/** The devices that can be simulated. "Off" is not one of them — it is a
 * null key, the way `panelPalettes` has no "no dithering" entry. */
export type DevicePresetKey = 'pi' | 'piZero' | 'esp32_16mb' | 'esp32'

export interface DevicePreset {
  key: DevicePresetKey
  label: string
  description: string
}

// ------------------------------------------------------------------- ESP32

/** FOS_NIM_EMERGENCY_RESERVE_BYTES: armed at boot, outside the render budget. */
const ESP32_EMERGENCY_RESERVE_BYTES = 1024 * 1024
/** FOS_RENDER_CANVAS_RGBX_MAX_PSRAM_SHARE (frameos_display.h): the canvas is
 * RGBX only while two of it fit the PSRAM heap; past that it is RGB565. */
const ESP32_RGBX_MAX_PSRAM_SHARE = 2
/** What the boards report as `hardware.memory.psramBytes`. Both are the whole
 * chip: a 16 MB module registers all of it with the heap. */
const ESP32_PSRAM_BYTES = 8 * 1024 * 1024
const ESP32_PSRAM_BYTES_16MB = 16 * 1024 * 1024
/** FOS_JS_MEMORY_LIMIT / FOS_JS_STACK_SIZE (fos_qjs_glue.c). */
const ESP32_JS_MEMORY_LIMIT_MB = 4
const ESP32_JS_MAX_STACK_KB = 20
/** The /state spill cap on PSRAM-tight boards. */
const ESP32_MAX_HTTP_RESPONSE_BYTES = 6 * 1024 * 1024

// ---------------------------------------------------------------- Raspberry

/** The GPU split a Pi takes off the top before Linux sees any RAM. Measured:
 * a 512 MB Pi Zero 2 W frame reports `memoryUsage.total` 471,011,328, which
 * is the nominal 512 MB less ~63 MB. */
const PI_GPU_SPLIT_BYTES = 64 * 1024 * 1024
/** What the OS and a resting FrameOS already hold before a render starts.
 * Measured on the same frame: 99,434,496 bytes used at idle, of which the
 * FrameOS process is 51,769,344 RSS. */
const PI_RESTING_BYTES = 100 * 1024 * 1024
/** LinuxReserveBytes in frameos/src/frameos/utils/memory.nim: the margin the
 * render pipeline plans below, for the page cache and everything that is not
 * the render. */
const PI_RENDER_RESERVE_BYTES = 48 * 1024 * 1024

const PI_ZERO_NOMINAL_BYTES = 512 * 1024 * 1024
const PI_NOMINAL_BYTES = 1024 * 1024 * 1024

export const devicePresets: DevicePreset[] = [
  {
    key: 'pi',
    label: 'Raspberry Pi · 1 GB',
    description: 'A Pi 3/4/5-class frame: most of a gigabyte free, default JS limits.',
  },
  {
    key: 'piZero',
    label: 'Raspberry Pi Zero · 512 MB',
    description: 'A Pi Zero-class frame: a third of a gigabyte free once the GPU split and the OS are out.',
  },
  {
    key: 'esp32_16mb',
    label: 'ESP32 · 16 MB PSRAM',
    description: 'A 16 MB ESP32-S3 frame: room for a full RGBX canvas and several megabytes on top.',
  },
  {
    key: 'esp32',
    label: 'ESP32 · 8 MB PSRAM',
    description:
      'A reTerminal-class 8 MB ESP32-S3 frame — the tightest FrameOS runs on: a 4 MB JS heap, a 20 KB JS stack and a 6 MB HTTP cap.',
  },
]

export function devicePresetFor(key: string | null | undefined): DevicePreset | null {
  if (!key) return null
  return devicePresets.find((preset) => preset.key === key) ?? null
}

/** Bytes per canvas pixel on an ESP32: RGBX while two of it fit PSRAM, RGB565
 * beyond — which is where a 13.3" panel on an 8 MB board lands, and a 16 MB
 * board does not (verified against a live 16 MB frame: 6,537 KB free PSRAM
 * mid-scene at 1200x1600 is exactly an RGBX canvas plus the panel buffer and
 * the reserve). */
export function esp32CanvasBytesPerPixel(
  width: number,
  height: number,
  psramBytes: number = ESP32_PSRAM_BYTES
): number {
  const pixels = Math.max(1, width) * Math.max(1, height)
  return pixels * 4 * ESP32_RGBX_MAX_PSRAM_SHARE <= psramBytes ? 4 : 2
}

/** The heap an ESP32-S3 frame really has for rendering: PSRAM, less the packed
 * 4 bpp panel buffer the display driver owns and the emergency reserve armed
 * at boot. The canvas is allocated out of what is left. */
export function esp32DeviceHeapBytes(
  width: number,
  height: number,
  psramBytes: number = ESP32_PSRAM_BYTES
): number {
  const pixels = Math.max(1, width) * Math.max(1, height)
  const packedBytes = Math.ceil(pixels / 2)
  return Math.max(512 * 1024, psramBytes - packedBytes - ESP32_EMERGENCY_RESERVE_BYTES)
}

/** What the preview spends on the canvas that the device does not: a frame
 * that keeps its canvas in RGB565 needs that term doubled here, because the
 * preview runtime keeps every image in RGBX. Zero wherever the two agree. */
export function esp32PreviewOverheadBytes(
  width: number,
  height: number,
  psramBytes: number = ESP32_PSRAM_BYTES
): number {
  const pixels = Math.max(1, width) * Math.max(1, height)
  return pixels * 4 - pixels * esp32CanvasBytesPerPixel(width, height, psramBytes)
}

/** The ceiling to give the preview so it has the same room the device does:
 * the device's heap, plus whatever the canvas costs extra here.
 *
 * The preview's other images are RGBX too, so a scene that only just fits on
 * the device can still report out-of-memory here. The simulation errs towards
 * "too heavy", which is the useful direction for a will-this-fit check. */
export function esp32PreviewMemoryBytes(
  width: number,
  height: number,
  psramBytes: number = ESP32_PSRAM_BYTES
): number {
  return (
    esp32DeviceHeapBytes(width, height, psramBytes) +
    esp32PreviewOverheadBytes(width, height, psramBytes)
  )
}

/** What a Pi frame has free for rendering: the board's RAM, less the GPU
 * split Linux never sees and the OS plus resting FrameOS on top of it. */
export function piDeviceHeapBytes(nominalRamBytes: number): number {
  return Math.max(64 * 1024 * 1024, nominalRamBytes - PI_GPU_SPLIT_BYTES - PI_RESTING_BYTES)
}

/** One line naming the ceilings, for people and for the AI's context. */
export function describeDeviceLimits(limits: DeviceLimits): string {
  const parts: string[] = []
  if (limits.memoryBytes > 0) {
    const mb = (limits.memoryBytes - limits.previewOverheadBytes) / (1024 * 1024)
    parts.push(`about ${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB of render memory`)
  }
  if (limits.jsMemoryLimitMb >= 0) parts.push(`${limits.jsMemoryLimitMb} MB JS heap`)
  if (limits.jsMaxStackKb >= 0) parts.push(`${limits.jsMaxStackKb} KB JS stack`)
  if (limits.maxHttpResponseBytes > 0) {
    parts.push(`${Math.round(limits.maxHttpResponseBytes / (1024 * 1024))} MB max HTTP response`)
  }
  return parts.join(', ')
}

/** The limits for a preset at a given panel size, or null for no simulation.
 * Panel size matters on the ESP32: the canvas comes out of the same PSRAM as
 * everything else, so a bigger panel leaves less of it. */
export function deviceLimitsFor(
  key: string | null | undefined,
  width: number,
  height: number
): DeviceLimits | null {
  const pi = (nominalRamBytes: number): DeviceLimits => ({
    memoryBytes: piDeviceHeapBytes(nominalRamBytes),
    memoryReserveBytes: PI_RENDER_RESERVE_BYTES,
    previewOverheadBytes: 0,
    jsMemoryLimitMb: -1,
    jsMaxStackKb: -1,
    maxHttpResponseBytes: 0,
  })
  const esp32 = (psramBytes: number): DeviceLimits => ({
    memoryBytes: esp32PreviewMemoryBytes(width, height, psramBytes),
    // The firmware's separate PSRAM safety margin is deliberately not
    // simulated: subtracting it here shrank the planning budget enough that
    // the interpreter declined to fuse a panel into the canvas and allocated
    // a standalone image instead — the opposite of what the device does, and
    // a worse prediction of it. A Pi has no such cliff, so it keeps its.
    memoryReserveBytes: 0,
    previewOverheadBytes: esp32PreviewOverheadBytes(width, height, psramBytes),
    jsMemoryLimitMb: ESP32_JS_MEMORY_LIMIT_MB,
    jsMaxStackKb: ESP32_JS_MAX_STACK_KB,
    maxHttpResponseBytes: ESP32_MAX_HTTP_RESPONSE_BYTES,
  })

  switch (key) {
    case 'pi':
      return pi(PI_NOMINAL_BYTES)
    case 'piZero':
      return pi(PI_ZERO_NOMINAL_BYTES)
    case 'esp32_16mb':
      return esp32(ESP32_PSRAM_BYTES_16MB)
    case 'esp32':
      return esp32(ESP32_PSRAM_BYTES)
    default:
      return null
  }
}
