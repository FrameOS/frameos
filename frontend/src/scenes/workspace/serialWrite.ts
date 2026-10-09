/**
 * A Web Serial write that cannot hang forever.
 *
 * `writer.write()` resolves once the OS has taken the bytes. On a board whose
 * firmware is not reading its USB-Serial/JTAG endpoint (stock vendor
 * firmware, a chip sitting in ROM download mode, a crashed app) the endpoint
 * NAKs every OUT packet and that promise never settles. Every flow awaiting
 * it then hangs, and in the workspace that included the per-frame USB command
 * lock: the stuck command never released it, and every later command —
 * the "Flash" button included — logged "waiting for previous USB command to
 * finish" for good. A timed-out write aborts the writer (discarding what is
 * queued) and throws, so the caller's own cleanup runs and the lock frees.
 *
 * Deliberately a leaf module with no imports, like esp32WatchdogReset.ts: the
 * cloud enrollment flasher deep-imports it too.
 */

// Slack per byte over the wire time at 115200 baud (~0.09 ms/byte): a 4 KB
// usb_api payload chunk gets ~9 s, a console line ~5 s.
const BASE_TIMEOUT_MS = 5000
const PER_BYTE_TIMEOUT_MS = 1

export class SerialWriteTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `The board did not accept data over USB for ${Math.round(timeoutMs / 1000)} s — ` +
        'it is not reading its serial port (not running FrameOS yet, or stuck). ' +
        'Unplug it, plug it back in and try again.'
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
