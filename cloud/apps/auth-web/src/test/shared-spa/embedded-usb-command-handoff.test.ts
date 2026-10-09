// @vitest-environment jsdom
//
// A USB API command run while the log stream is open borrows the stream's
// port and gives it back. Two things broke that on a bare ESP32-S3:
//
// - Closing and reopening the port around the command toggles DTR/RTS, which
//   resets a chip on its own USB-Serial/JTAG (`rst:0x15 USB_UART_CHIP_RESET`).
// - The paused stream reported "idle", so the Connect card took the board for
//   unplugged, reset, and probed it again when the stream resumed — a `status`
//   loop that kept the USB queue busy ("waiting for previous USB command to
//   finish") and the Flash button waiting on it for good.
//
// kea must come from the frontend's node_modules: the model resolves it there.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContext, resetContext } from "../../../../../../frontend/node_modules/kea";
import {
  embeddedUsbLogsModel,
  runEmbeddedUsbApiCommand,
  startEmbeddedUsbLogStream,
  stopEmbeddedUsbLogStream,
} from "../../../../../../frontend/src/models/embeddedUsbLogsModel";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const frameId = 7;

// Web Serial's shape: readable/writable are recreated on access after a
// reader cancels them, and only exist while the port is open.
class FakeSerialPort {
  opens = 0;
  closes = 0;
  connected = true;
  private isOpen = false;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private currentReadable: ReadableStream<Uint8Array> | null = null;
  private currentWritable: WritableStream<Uint8Array> | null = null;

  getInfo() {
    return { usbVendorId: 0x303a, usbProductId: 0x1001 };
  }

  open() {
    if (this.isOpen) {
      return Promise.reject(new Error("The port is already open."));
    }
    this.isOpen = true;
    this.opens += 1;
    return Promise.resolve();
  }

  close() {
    this.isOpen = false;
    this.closes += 1;
    this.currentReadable = null;
    this.currentWritable = null;
    return Promise.resolve();
  }

  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.isOpen) {
      return null;
    }
    this.currentReadable ??= new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.currentReadable = null;
        this.controller = null;
      },
    });
    return this.currentReadable;
  }

  get writable(): WritableStream<Uint8Array> | null {
    if (!this.isOpen) {
      return null;
    }
    this.currentWritable ??= new WritableStream<Uint8Array>({
      write: (chunk) => {
        const line = decoder.decode(chunk).trim();
        const command = line.match(/^usb_api (\S+)/)?.[1];
        if (command) {
          // Answer once the command's reader is attached.
          setTimeout(() => this.controller?.enqueue(encoder.encode(`__FRAMEOS_USB_OK__ ${command}\n`)), 0);
        }
      },
    });
    return this.currentWritable;
  }
}

let statuses: string[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  resetContext();
  embeddedUsbLogsModel.mount();
  Object.defineProperty(navigator, "serial", {
    configurable: true,
    value: { getPorts: () => Promise.resolve([]), requestPort: () => Promise.reject(new Error("no prompt")) },
  });
  statuses = [];
  let last: string | undefined;
  unsubscribe = getContext().store.subscribe(() => {
    const status = embeddedUsbLogsModel.values.usbLogStreamStatesByFrameId[frameId]?.status;
    if (status && status !== last) {
      statuses.push(status);
    }
    last = status;
  });
});

afterEach(async () => {
  await stopEmbeddedUsbLogStream(frameId);
  unsubscribe();
  delete (navigator as { serial?: unknown }).serial;
});

describe("USB command hand-off from the log stream", () => {
  it("keeps the port open and never reports the stream idle", async () => {
    const port = new FakeSerialPort();
    expect(await startEmbeddedUsbLogStream(frameId, port as unknown as SerialPort)).toBe(true);
    statuses = [];

    const result = await runEmbeddedUsbApiCommand(frameId, "status", { probe: true, timeoutMs: 2000 });

    expect(result.command).toBe("status");
    // One open for the stream; the command and the resumed stream reuse it.
    expect(port.opens).toBe(1);
    expect(port.closes).toBe(0);
    // "idle" mid-command is what re-armed the Connect card's probe.
    expect(statuses.join(" > ")).not.toMatch(/idle/);
    expect(statuses.at(-1)).toBe("streaming");
  });
});
