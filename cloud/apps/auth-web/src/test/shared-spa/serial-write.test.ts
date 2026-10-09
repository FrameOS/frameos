import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SerialWriteTimeoutError,
  serialWriteTimeoutMs,
  writeWithTimeout,
} from "../../../../../../frontend/src/scenes/workspace/serialWrite";

// A board that never reads its USB-Serial/JTAG endpoint leaves writer.write()
// pending forever; the workspace's USB command lock then never released and
// every later command logged "waiting for previous USB command to finish".
afterEach(() => {
  vi.useRealTimers();
});

describe("writeWithTimeout", () => {
  it("resolves when the port takes the bytes", async () => {
    const written: Uint8Array[] = [];
    const writer = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk);
      },
    }).getWriter();

    await writeWithTimeout(writer, new Uint8Array([1, 2, 3]));

    expect(written).toHaveLength(1);
  });

  it("throws and aborts the writer when the write never settles", async () => {
    vi.useFakeTimers();
    const writer = new WritableStream<Uint8Array>({
      write() {
        return new Promise<void>(() => {});
      },
    }).getWriter();

    const result = writeWithTimeout(writer, new Uint8Array([1]), 1000);
    const assertion = expect(result).rejects.toBeInstanceOf(SerialWriteTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    // The writer was aborted: the stream is erroring, so the caller's
    // cleanup tears the port down instead of queueing behind the stuck write.
    await expect(writer.ready).rejects.toBeInstanceOf(SerialWriteTimeoutError);
    writer.releaseLock();
  });

  it("scales the budget with the chunk size", () => {
    expect(serialWriteTimeoutMs(0)).toBe(5000);
    expect(serialWriteTimeoutMs(4096)).toBeGreaterThan(serialWriteTimeoutMs(16));
  });
});
