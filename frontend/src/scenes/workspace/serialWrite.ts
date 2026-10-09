/**
 * A Web Serial write that cannot hang forever. A board that is not reading its
 * USB-Serial/JTAG port (other firmware, download mode) never accepts the
 * bytes, and the pending write used to hold the USB command lock for good.
 * On timeout the writer is aborted and the caller's cleanup runs.
 *
 * A leaf module with no imports: the cloud flasher deep-imports it.
 */

// Slack per byte over the wire time at 115200 baud (~0.09 ms/byte): a 4 KB
// usb_api payload chunk gets ~9 s, a console line ~5 s.
const BASE_TIMEOUT_MS = 5000
const PER_BYTE_TIMEOUT_MS = 1

export class SerialWriteTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `The board stopped accepting data over USB for ${Math.round(timeoutMs / 1000)} s. ` +
        'It may not be running FrameOS yet, or it is stuck. Unplug it, plug it back in and try again.'
    )
    this.name = 'SerialWriteTimeoutError'
  }
}

export function serialWriteTimeoutMs(byteLength: number): number {
  return BASE_TIMEOUT_MS + byteLength * PER_BYTE_TIMEOUT_MS
}

export async function writeWithTimeout(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  chunk: Uint8Array,
  timeoutMs: number = serialWriteTimeoutMs(chunk.byteLength)
): Promise<void> {
  const pending = writer.write(chunk)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SerialWriteTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } catch (error) {
    if (error instanceof SerialWriteTimeoutError) {
      // The stuck write rejects once the abort lands; nobody awaits it now.
      pending.catch(() => {})
      // Not awaited: on a wedged endpoint the abort itself may take a while,
      // and the caller's cleanup (releaseLock, close) must not wait on it.
      writer.abort(error).catch(() => {})
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
