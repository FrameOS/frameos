// Device simulation presets for the wasm preview.
//
// A preset turns into `DeviceLimits` — the ceilings the preview runtime
// enforces via frameos_wasm_set_device_limits: render-memory budget (feeding
// the same decode budgets and degrade-to-blur ladder a real device uses),
// QuickJS heap/stack ceilings, and the HTTP response cap. The ESP32 numbers
// mirror the firmware and backend constants; keep them in step with
// embedded/esp32/components/frameos_display/frameos_display.c,
// components/frameos_quickjs/fos_qjs_glue.c and
// backend/app/tasks/embedded_firmware.py.

export interface DeviceLimits {
  /** Render-memory budget in bytes (availableRenderBytes on the device). */
  availableRenderBytes: number
  /** QuickJS heap ceiling per scene context, in MB; -1 keeps the host default (256 MB). */
  jsMemoryLimitMb: number
  /** QuickJS stack ceiling in KB; -1 keeps the host default (256 KB). */
  jsMaxStackKb: number
  /** HTTP response cap in bytes; 0 keeps the host default (64 MB). */
  maxHttpResponseBytes: number
}

export type DevicePresetKey = 'browser' | 'pi' | 'piZero' | 'esp32'

export interface DevicePreset {
  key: DevicePresetKey
  label: string
  /** One-line summary of what the preset constrains. */
  description: string
}

// FOS_RENDER_PSRAM_RESERVE / EMBEDDED_RENDER_PSRAM_RESERVE_BYTES: packed
// framebuffer headroom, preview snapshot and C-side HTTP/TLS buffers.
const ESP32_PSRAM_RESERVE_BYTES = 1536 * 1024
// FOS_NIM_EMERGENCY_RESERVE_BYTES: armed at boot, unavailable to renders.
const ESP32_EMERGENCY_RESERVE_BYTES = 1024 * 1024
// FOS_RENDER_CANVAS_RGBX_MAX_PSRAM_SHARE: RGBX canvas only while it fits
// twice into PSRAM, otherwise the firmware falls back to RGB565.
const ESP32_RGBX_MAX_PSRAM_SHARE = 2
// Current ESP32-S3 modules (reTerminal E1002/E1004) ship 8 MB of PSRAM.
const ESP32_PSRAM_BYTES = 8 * 1024 * 1024
// FOS_JS_MEMORY_LIMIT / FOS_JS_STACK_SIZE (fos_qjs_glue.c).
const ESP32_JS_MEMORY_LIMIT_MB = 4
const ESP32_JS_MAX_STACK_KB = 20
// The /state spill cap on PSRAM-tight boards ("response exceeded ... bytes").
const ESP32_MAX_HTTP_RESPONSE_BYTES = 6 * 1024 * 1024

export const devicePresets: DevicePreset[] = [
  {
    key: 'browser',
    label: 'Browser (no limits)',
    description: 'Renders with the browser’s own memory; nothing is simulated.',
  },
  {
    key: 'pi',
    label: 'Raspberry Pi · 1 GB+',
    description: 'A Pi 3/4/5-class frame: ample render memory, default JS limits.',
  },
  {
    key: 'piZero',
    label: 'Raspberry Pi Zero · 512 MB',
    description: 'A Pi Zero-class frame: render memory capped near what a Zero has free.',
  },
  {
    key: 'esp32',
    label: 'ESP32 · 8 MB PSRAM',
    description:
      'A reTerminal-class ESP32-S3 frame: a few MB of render memory, a 4 MB JS heap, a 20 KB JS stack and a 6 MB HTTP cap.',
  },
]

export function devicePresetFor(key: string | null | undefined): DevicePreset | null {
  if (!key || key === 'browser') {
    return null
  }
  return devicePresets.find((preset) => preset.key === key) ?? null
}

/** The render-memory budget an 8 MB ESP32-S3 board has left for a given
 * panel size: PSRAM minus the boot-reserved canvas (RGBX while it fits twice
 * into PSRAM, RGB565 beyond), the packed panel buffer (4 bpp, Spectra-class),
 * the PSRAM reserve and the armed emergency reserve. 800×480 lands near the
 * 4 MB the ESP32 test corpus pins; 1200×1600 lands under 1 MB, which is what
 * the 13.3" boards really have. */
export function esp32RenderBudgetBytes(width: number, height: number): number {
  const pixels = Math.max(1, width) * Math.max(1, height)
  const canvasBytesPerPixel = pixels * 4 * ESP32_RGBX_MAX_PSRAM_SHARE <= ESP32_PSRAM_BYTES ? 4 : 2
  const canvasBytes = pixels * canvasBytesPerPixel
  const packedBytes = Math.ceil(pixels / 2)
  const budget =
    ESP32_PSRAM_BYTES - canvasBytes - packedBytes - ESP32_PSRAM_RESERVE_BYTES - ESP32_EMERGENCY_RESERVE_BYTES
  return Math.max(budget, 512 * 1024)
}

/** One line naming the ceilings, for people and for the AI's context:
 * "about 3.9 MB render memory, 4 MB JS heap, 20 KB JS stack, 6 MB max HTTP
 * response". */
export function describeDeviceLimits(limits: DeviceLimits): string {
  const parts: string[] = []
  if (limits.availableRenderBytes > 0) {
    const mb = limits.availableRenderBytes / (1024 * 1024)
    parts.push(`about ${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB render memory`)
  }
  if (limits.jsMemoryLimitMb >= 0) {
    parts.push(`${limits.jsMemoryLimitMb} MB JS heap`)
  }
  if (limits.jsMaxStackKb >= 0) {
    parts.push(`${limits.jsMaxStackKb} KB JS stack`)
  }
  if (limits.maxHttpResponseBytes > 0) {
    parts.push(`${Math.round(limits.maxHttpResponseBytes / (1024 * 1024))} MB max HTTP response`)
  }
  return parts.join(', ')
}

/** The limits to pass to the preview for a preset, or null for no simulation
 * (the browser preset, or an unknown key). Depends on the viewport: the ESP32
 * canvas is reserved at boot, so a bigger panel leaves less to render with. */
export function deviceLimitsFor(
  key: string | null | undefined,
  width: number,
  height: number
): DeviceLimits | null {
  switch (key) {
    case 'pi':
      return {
        availableRenderBytes: 512 * 1024 * 1024,
        jsMemoryLimitMb: -1,
        jsMaxStackKb: -1,
        maxHttpResponseBytes: 0,
      }
    case 'piZero':
      return {
        availableRenderBytes: 256 * 1024 * 1024,
        jsMemoryLimitMb: -1,
        jsMaxStackKb: -1,
        maxHttpResponseBytes: 0,
      }
    case 'esp32':
      return {
        availableRenderBytes: esp32RenderBudgetBytes(width, height),
        jsMemoryLimitMb: ESP32_JS_MEMORY_LIMIT_MB,
        jsMaxStackKb: ESP32_JS_MAX_STACK_KB,
        maxHttpResponseBytes: ESP32_MAX_HTTP_RESPONSE_BYTES,
      }
    default:
      return null
  }
}
