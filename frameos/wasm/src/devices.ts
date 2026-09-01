// Device memory simulation for the preview.
//
// The preview runs the real interpreter, but a browser has effectively
// unlimited memory, so a scene that exhausts an ESP32's PSRAM previews
// perfectly and only fails once it reaches hardware. Picking a device here
// puts the runtime under that device's ceiling: allocations past it are
// refused the way they are on a full frame, and the render comes back as
// `outOfMemory` instead of a picture.
//
// The ESP32 numbers mirror the firmware constants; keep them in step with
// embedded/esp32/components/frameos_display/frameos_display.c,
// components/frameos_nim/frameos_nim_glue.c and
// components/frameos_quickjs/fos_qjs_glue.c.

export interface DeviceLimits {
  /** Ceiling on the runtime's heap, in bytes. 0 = no simulation. */
  memoryBytes: number
  /** Margin the render pipeline keeps below the ceiling when planning
   * decodes (the device's availableRenderBytes reserve). Allocation still
   * succeeds into it. */
  memoryReserveBytes: number
  /** QuickJS heap ceiling per scene context, in MB; -1 keeps the host default. */
  jsMemoryLimitMb: number
  /** QuickJS stack ceiling in KB; -1 keeps the host default. */
  jsMaxStackKb: number
  /** HTTP response cap in bytes; 0 keeps the host default. */
  maxHttpResponseBytes: number
}

export type DevicePresetKey = 'browser' | 'pi' | 'piZero' | 'esp32'

export interface DevicePreset {
  key: DevicePresetKey
  label: string
  description: string
}

/** FOS_NIM_EMERGENCY_RESERVE_BYTES: armed at boot, outside the render budget. */
const ESP32_EMERGENCY_RESERVE_BYTES = 1024 * 1024
/** FOS_RENDER_CANVAS_RGBX_MAX_PSRAM_SHARE: the canvas is RGBX only while it
 * fits twice into PSRAM; past that the firmware keeps it in RGB565. */
const ESP32_RGBX_MAX_PSRAM_SHARE = 2
/** Current ESP32-S3 frames (reTerminal E1002/E1004) ship 8 MB of PSRAM. */
const ESP32_PSRAM_BYTES = 8 * 1024 * 1024
/** FOS_JS_MEMORY_LIMIT / FOS_JS_STACK_SIZE (fos_qjs_glue.c). */
const ESP32_JS_MEMORY_LIMIT_MB = 4
const ESP32_JS_MAX_STACK_KB = 20
/** The /state spill cap on PSRAM-tight boards. */
const ESP32_MAX_HTTP_RESPONSE_BYTES = 6 * 1024 * 1024

export const devicePresets: DevicePreset[] = [
  {
    key: 'browser',
    label: 'Browser (no limit)',
    description: 'Renders with the browser’s own memory; nothing is simulated.',
  },
  {
    key: 'pi',
    label: 'Raspberry Pi · 1 GB+',
    description: 'A Pi 3/4/5-class frame: ample memory, default JS limits.',
  },
  {
    key: 'piZero',
    label: 'Raspberry Pi Zero · 512 MB',
    description: 'A Pi Zero-class frame: memory capped near what a Zero has free.',
  },
  {
    key: 'esp32',
    label: 'ESP32 · 8 MB PSRAM',
    description:
      'A reTerminal-class ESP32-S3 frame: PSRAM minus the panel buffer and the emergency reserve, plus a 4 MB JS heap, a 20 KB JS stack and a 6 MB HTTP cap.',
  },
]

export function devicePresetFor(key: string | null | undefined): DevicePreset | null {
  if (!key || key === 'browser') return null
  return devicePresets.find((preset) => preset.key === key) ?? null
}

/** Bytes per canvas pixel on an 8 MB ESP32: RGBX while the canvas fits twice
 * into PSRAM, RGB565 beyond — which is where every 13.3" board lands. */
export function esp32CanvasBytesPerPixel(width: number, height: number): number {
  const pixels = Math.max(1, width) * Math.max(1, height)
  return pixels * 4 * ESP32_RGBX_MAX_PSRAM_SHARE <= ESP32_PSRAM_BYTES ? 4 : 2
}

/** The heap an 8 MB ESP32-S3 frame really has for rendering: PSRAM, less the
 * packed 4 bpp panel buffer the display driver owns and the emergency reserve
 * armed at boot. The canvas is allocated out of what is left. */
export function esp32DeviceHeapBytes(width: number, height: number): number {
  const pixels = Math.max(1, width) * Math.max(1, height)
  const packedBytes = Math.ceil(pixels / 2)
  return Math.max(
    512 * 1024,
    ESP32_PSRAM_BYTES - packedBytes - ESP32_EMERGENCY_RESERVE_BYTES
  )
}

/** The ceiling to give the preview so it has the same room the device does.
 *
 * One correction is needed on the way: a 13.3" frame keeps its canvas in
 * RGB565, and the preview runtime keeps every image in RGBX, so the same
 * canvas costs twice as much here. Convert that one term and the rest of the
 * render — scene graph, JS runtimes, transpiler, decode buffers — competes
 * for exactly the bytes it would on hardware.
 *
 * The preview's other images are RGBX too, so a scene that only just fits on
 * the device can still report out-of-memory here. The simulation errs towards
 * "too heavy", which is the useful direction for a will-this-fit check. */
export function esp32PreviewMemoryBytes(width: number, height: number): number {
  const pixels = Math.max(1, width) * Math.max(1, height)
  const deviceCanvasBytes = pixels * esp32CanvasBytesPerPixel(width, height)
  const previewCanvasBytes = pixels * 4
  return esp32DeviceHeapBytes(width, height) - deviceCanvasBytes + previewCanvasBytes
}

/** One line naming the ceilings, for people and for the AI's context. */
export function describeDeviceLimits(limits: DeviceLimits): string {
  const parts: string[] = []
  if (limits.memoryBytes > 0) {
    const mb = limits.memoryBytes / (1024 * 1024)
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
 * Panel size matters: the canvas comes out of the same memory as everything
 * else, so a bigger panel leaves less of it. */
export function deviceLimitsFor(
  key: string | null | undefined,
  width: number,
  height: number
): DeviceLimits | null {
  switch (key) {
    case 'pi':
      return {
        memoryBytes: 512 * 1024 * 1024,
        memoryReserveBytes: 0,
        jsMemoryLimitMb: -1,
        jsMaxStackKb: -1,
        maxHttpResponseBytes: 0,
      }
    case 'piZero':
      return {
        memoryBytes: 256 * 1024 * 1024,
        memoryReserveBytes: 0,
        jsMemoryLimitMb: -1,
        jsMaxStackKb: -1,
        maxHttpResponseBytes: 0,
      }
    case 'esp32':
      return {
        memoryBytes: esp32PreviewMemoryBytes(width, height),
        // The firmware's separate PSRAM safety margin is deliberately not
        // simulated: subtracting it here shrank the planning budget enough
        // that the interpreter declined to fuse a panel into the canvas and
        // allocated a standalone image instead — the opposite of what the
        // device does, and a worse prediction of it.
        memoryReserveBytes: 0,
        jsMemoryLimitMb: ESP32_JS_MEMORY_LIMIT_MB,
        jsMaxStackKb: ESP32_JS_MAX_STACK_KB,
        maxHttpResponseBytes: ESP32_MAX_HTTP_RESPONSE_BYTES,
      }
    default:
      return null
  }
}
