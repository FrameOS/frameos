import { esp32DeviceLimits, type DeviceLimits } from "frameos-wasm";
import { frameHardwareIsEsp32 } from "../frames";

// The memory a frame renders its scenes in, so the chat's render_scene runs
// out of memory where the frame would (docs/ai-chat.md) instead of drawing a
// scene that then aborts on the device. An ESP32 renders in its PSRAM, a few
// megabytes, and runs as an ESP32; a Pi has hundreds of megabytes to spare
// and a PSRAM-less board renders nothing itself, so both are null. The SPA's
// render check makes the same call (frontend/src/utils/frameRenderDevice.ts).

export type RenderDevice = { label: string; psramBytes: number };

/** What the 8 MB boards report; the tightest FrameOS renders on. */
const defaultEsp32PsramBytes = 8 * 1024 * 1024;

export function frameRenderDevice(frame: { hardware: unknown }): RenderDevice | null {
  if (!frameHardwareIsEsp32(frame)) {
    return null;
  }
  const memory = (frame.hardware as { memory?: { psramBytes?: unknown } | null } | null)?.memory;
  const reported = memory?.psramBytes;
  // Firmware from before 2026.8 reports no memory at all.
  const psramBytes =
    typeof reported === "number" && Number.isFinite(reported) ? reported : defaultEsp32PsramBytes;
  if (psramBytes <= 0) {
    return null;
  }
  const megabytes = Math.round((psramBytes / (1024 * 1024)) * 10) / 10;
  return { label: `ESP32 with ${megabytes} MB PSRAM`, psramBytes };
}

/** The ceiling a render at this size runs under: on an ESP32 the canvas
 * comes out of the same PSRAM, so the panel size matters. */
export function renderDeviceLimits(
  device: RenderDevice,
  width: number,
  height: number,
): DeviceLimits {
  return esp32DeviceLimits(width, height, device.psramBytes);
}
