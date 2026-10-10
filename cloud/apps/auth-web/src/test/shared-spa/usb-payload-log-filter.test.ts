// @vitest-environment jsdom
//
// `usb_api image` on an E1004 (CH340 at 115200 baud) streams a 1200x1600
// preview as 1.28 MB of base64: about two minutes on the wire. The command
// gave up after 45 s, handed the port back to the log stream, and the stream
// logged the rest of the payload line by line — its own protocol filter had
// never seen the BEGIN. The filter also budgeted base64 payloads in decoded
// bytes, so even a payload it did see leaked its last quarter. And a preview
// that holds the console for two minutes is not pulled through a USB-UART
// bridge in the first place.
//
// kea must come from the frontend's node_modules: the model resolves it there.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetContext } from "../../../../../../frontend/node_modules/kea";
import {
  createUsbProtocolLogFilter,
  embeddedUsbLinkIsUartBridge,
  embeddedUsbLogsModel,
  runEmbeddedUsbApiCommand,
  startEmbeddedUsbLogStream,
  stopEmbeddedUsbLogStream,
  usbPayloadTransferMs,
} from "../../../../../../frontend/src/models/embeddedUsbLogsModel";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The firmware's FOS_USB_API_RAW_CHUNK: one base64 line per 384 bytes.
function base64Lines(bytes: Uint8Array, chunk = 384): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    lines.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunk))));
  }
  return lines;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSerialPort {
  connected = true;
  private isOpen = false;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private currentReadable: ReadableStream<Uint8Array> | null = null;
  private currentWritable: WritableStream<Uint8Array> | null = null;

  constructor(
    private readonly respond: (command: string, port: FakeSerialPort) => void,
    // A CH340, as on the E10xx boards.
    private readonly usbVendorId = 0x1a86,
  ) {}

  send(text: string) {
    this.controller?.enqueue(encoder.encode(text));
  }

  getInfo() {
    return { usbVendorId: this.usbVendorId, usbProductId: 0x7523 };
  }

  open() {
    this.isOpen = true;
    return Promise.resolve();
  }

  close() {
    this.isOpen = false;
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
        const command = decoder.decode(chunk).trim().match(/^usb_api (\S+)/)?.[1];
        if (command) {
          // Answer once the command's reader is attached.
          setTimeout(() => this.respond(command, this), 0);
        }
      },
    });
    return this.currentWritable;
  }
}

function usbLogLines(frameId: number): string[] {
  return (embeddedUsbLogsModel.values.usbLogsByFrameId[frameId] ?? []).map((log) => log.line);
}

beforeEach(() => {
  resetContext();
  embeddedUsbLogsModel.mount();
  Object.defineProperty(navigator, "serial", {
    configurable: true,
    value: { getPorts: () => Promise.resolve([]), requestPort: () => Promise.reject(new Error("no prompt")) },
  });
});

afterEach(async () => {
  for (const frameId of [11, 12, 13, 14]) {
    await stopEmbeddedUsbLogStream(frameId);
  }
  delete (navigator as { serial?: unknown }).serial;
});

describe("USB protocol log filter", () => {
  it("drops every line of a base64 payload, not just the first three quarters", () => {
    const filter = createUsbProtocolLogFilter();
    // A 13.3" preview's tail shape: 100 full lines and an 81-byte last one.
    const bytes = new Uint8Array(384 * 100 + 81).fill(0x11);
    const shown = [
      `__FRAMEOS_USB_BEGIN__ image ${bytes.byteLength} base64 scene=abc`,
      ...base64Lines(bytes),
      "__FRAMEOS_USB_END__ image",
      "I (1234) render: done",
    ]
      .map(filter)
      .filter((line) => line !== null);

    expect(shown).toEqual(["I (1234) render: done"]);
  });

  it("shows a console line another task printed mid-payload", () => {
    const filter = createUsbProtocolLogFilter();
    const [first, second] = base64Lines(new Uint8Array(768).fill(0x33));
    const shown = [
      "__FRAMEOS_USB_BEGIN__ image 768 base64",
      first,
      "W (99) cloud: reconnecting",
      second,
      "__FRAMEOS_USB_END__ image",
    ]
      .map((line) => filter(line ?? ""))
      .filter((line) => line !== null);

    expect(shown).toEqual(["W (99) cloud: reconnecting"]);
  });
});

describe("USB payloads slower than the command timeout", () => {
  it("waits as long as the declared payload needs at the console baud", async () => {
    const frameId = 11;
    const bytes = new Uint8Array(3000).fill(0x55);
    const lines = base64Lines(bytes);
    // 4000 characters at 11.5 KB/s, with margin: ~0.5 s, far over 100 ms.
    expect(usbPayloadTransferMs(bytes.byteLength, "base64")).toBeGreaterThan(400);
    const port = new FakeSerialPort((command, device) => {
      device.send(`__FRAMEOS_USB_BEGIN__ ${command} ${bytes.byteLength} base64 scene=s1\r\n${lines[0]}\r\n`);
      setTimeout(() => device.send(`${lines.slice(1).join("\r\n")}\r\n__FRAMEOS_USB_END__ ${command}\r\n`), 250);
    });

    const result = await runEmbeddedUsbApiCommand(frameId, "image", {
      port: port as unknown as SerialPort,
      timeoutMs: 100,
    });

    expect(result.bytes?.byteLength).toBe(bytes.byteLength);
    expect(result.metadata).toBe("scene=s1");
    expect(usbLogLines(frameId).some((line) => /^[A-Za-z0-9+/=]{64,}$/.test(line))).toBe(false);
  });

  it("keeps a payload the command gave up on out of the resumed log stream", async () => {
    const frameId = 12;
    // Small enough that the declared transfer time ends long before the tail.
    const bytes = new Uint8Array(30).fill(0x11);
    const lines = base64Lines(bytes, 15);
    const port = new FakeSerialPort((command, device) => {
      if (command !== "image") {
        return;
      }
      device.send(`__FRAMEOS_USB_BEGIN__ image ${bytes.byteLength} base64\r\n${lines[0]}\r\n`);
      setTimeout(() => device.send(`${lines[1]}\r\n__FRAMEOS_USB_END__ image\r\nI (5) render: after\r\n`), 300);
    });
    expect(await startEmbeddedUsbLogStream(frameId, port as unknown as SerialPort)).toBe(true);

    await expect(runEmbeddedUsbApiCommand(frameId, "image", { timeoutMs: 50 })).rejects.toThrow(/Timed out/);
    await sleep(400);

    const logged = usbLogLines(frameId);
    expect(logged).toContain("I (5) render: after");
    expect(logged).not.toContain(lines[1]);
  });
});

describe("USB link speed", () => {
  it("tells a USB-UART bridge from Espressif's own USB", async () => {
    const bridge = new FakeSerialPort(() => {});
    const native = new FakeSerialPort(() => {}, 0x303a);
    expect(await startEmbeddedUsbLogStream(13, bridge as unknown as SerialPort)).toBe(true);
    expect(await startEmbeddedUsbLogStream(14, native as unknown as SerialPort)).toBe(true);

    expect(embeddedUsbLinkIsUartBridge(13)).toBe(true);
    expect(embeddedUsbLinkIsUartBridge(14)).toBe(false);
    // No port, no link to judge.
    expect(embeddedUsbLinkIsUartBridge(15)).toBe(false);
  });
});
