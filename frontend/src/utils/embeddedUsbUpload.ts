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

/** The most one `usb_api upload-scenes` may carry, and what one
 * `scenes-deflated` may inflate to: the board holds a whole set in memory to
 * store it, up to FOS_SCENES_HELD_MAX_BYTES (fos_scenes.h), and refuses more
 * ("invalid scenes payload length"). A bigger set goes in more than one
 * (embedded/esp32/README.md "How big a set may be"). */
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

/** A set as `usb_api scenes-deflated` takes it: in order, in batches of at
 * most `maxBytes` of JSON each (a scene bigger than that alone). The first
 * replaces what the board held (`set`), the rest are added to it (`put`). */
export function embeddedUsbScenesBatches<T>(
  scenes: readonly T[],
  maxBytes: number = EMBEDDED_USB_WHOLE_SET_MAX_BYTES
): T[][] {
  const batches: T[][] = []
  let rest: readonly T[] = scenes
  while (rest.length > 0) {
    const { whole, each } = embeddedUsbScenesUploadPlan(rest, maxBytes)
    batches.push(whole)
    rest = each
  }
  return batches
}

/** `bytes` as a zlib stream (RFC 1950), what `usb_api scenes-deflated`
 * inflates with the ESP32 ROM's tinfl; its Adler-32 is the board's check of
 * what came over the cable. Scene JSON deflates to about a third. */
export async function deflateForUsb(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  const written = writer.write(bytes).then(() => writer.close())
  const chunks: Uint8Array[] = []
  let length = 0
  const reader = stream.readable.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    chunks.push(value)
    length += value.byteLength
  }
  await written
  const deflated = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    deflated.set(chunk, at)
    at += chunk.byteLength
  }
  return deflated
}
