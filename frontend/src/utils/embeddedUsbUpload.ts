const EMBEDDED_USB_UPLOAD_MIN_TIMEOUT_MS = 45000
const EMBEDDED_USB_UPLOAD_BASE_TIMEOUT_MS = 30000
const EMBEDDED_USB_UPLOAD_TIMEOUT_MS_PER_KB = 250

/** How long a payload over the USB console (`upload-scenes`) may take: the
 * console reads it at 115200 baud on a USB-UART bridge. */
export function embeddedUsbUploadTimeoutMs(payloadBytes: number): number {
  return Math.max(
    EMBEDDED_USB_UPLOAD_MIN_TIMEOUT_MS,
    EMBEDDED_USB_UPLOAD_BASE_TIMEOUT_MS + Math.ceil(payloadBytes / 1024) * EMBEDDED_USB_UPLOAD_TIMEOUT_MS_PER_KB
  )
}

/** The most one `usb_api upload-scenes` may carry: the board holds a whole
 * set in memory to store it, up to SCENES_HELD_MAX_BYTES (fos_scenes.c), and
 * refuses more ("invalid scenes payload length"). A bigger set goes a scene
 * at a time after it (`usb_api scene-put`, embedded/esp32/README.md "How big
 * a set may be"). */
export const EMBEDDED_USB_WHOLE_SET_MAX_BYTES = 512 * 1024

/** How a set goes over the console: `whole`, the first scenes that fit one
 * `upload-scenes` (which replaces what the board held), then `each` alone. */
export interface EmbeddedUsbScenesUploadPlan<T> {
  whole: T[]
  each: T[]
}

export function embeddedUsbScenesUploadPlan<T>(
  scenes: readonly T[],
  maxBytes: number = EMBEDDED_USB_WHOLE_SET_MAX_BYTES
): EmbeddedUsbScenesUploadPlan<T> {
  const encoder = new TextEncoder()
  // `[` and `]`, and a comma before every scene but the first.
  let bytes = 2
  let fits = 0
  for (const scene of scenes) {
    const sceneBytes = encoder.encode(JSON.stringify(scene)).byteLength + (fits > 0 ? 1 : 0)
    if (fits > 0 && bytes + sceneBytes > maxBytes) {
      break
    }
    bytes += sceneBytes
    fits += 1
  }
  return { whole: scenes.slice(0, fits), each: scenes.slice(fits) }
}
