import { esp32DeviceLimits, type DeviceLimits } from './deviceLimits'
import { isEsp32Frame } from '../scenes/workspace/workspaceSurfaces'
import type { FrameType } from '../types'

/** What the 8 MB boards report; the tightest FrameOS renders on. */
const DEFAULT_ESP32_PSRAM_BYTES = 8 * 1024 * 1024

export interface FrameRenderDevice {
  /** "ESP32 with 8 MB PSRAM at 1200x1600": for the chat log and the AI. */
  label: string
  limits: DeviceLimits
}

/**
 * The memory a frame renders its scenes in, for a render that should run out
 * of memory where the frame would (the AI chat's render check,
 * docs/ai-chat.md). An ESP32 that renders on the device gets its PSRAM at its
 * panel size and runs as an ESP32. Null for everything else: a Pi has
 * hundreds of megabytes to spare, and a thin client's scenes are rendered by
 * the control plane, not the device.
 *
 * The backend derives the PSRAM from the board (`embedded.layout.ram`); a
 * cloud frame reports it (`hardware.memory.psramBytes`). A frame that reports
 * nothing is taken to be an 8 MB board.
 */
export function frameRenderDevice(frame: Partial<FrameType> | null | undefined): FrameRenderDevice | null {
  if (!frame || !isEsp32Frame(frame)) {
    return null
  }
  const ram = frame.embedded?.layout?.ram
  if (ram?.renderMode === 'remote') {
    return null
  }
  const psramBytes = ram?.psramBytes ?? frame.hardware?.memory?.psramBytes ?? DEFAULT_ESP32_PSRAM_BYTES
  const width = frame.width || ram?.width || 0
  const height = frame.height || ram?.height || 0
  if (psramBytes <= 0 || width <= 0 || height <= 0) {
    return null
  }
  const megabytes = Math.round((psramBytes / (1024 * 1024)) * 10) / 10
  return {
    label: `ESP32 with ${megabytes} MB PSRAM at ${width}x${height}`,
    limits: esp32DeviceLimits(width, height, psramBytes),
  }
}
