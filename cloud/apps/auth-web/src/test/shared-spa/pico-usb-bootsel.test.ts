// @vitest-environment jsdom
//
// `usb_api bootsel` — the Pico's "update firmware" path. The board acks OK and
// reboots into its UF2 bootloader, where it is a USB DRIVE, not a serial port:
// unlike `restart`, nothing comes back to reconnect to. What this pins is that
// the helper sends exactly that command, resolves on the ack, and ENDS the USB
// session (port closed and forgotten, stream idle) instead of entering the
// 60-second wait-for-the-port-to-return that every other rebooting verb runs.
//
// Lives here (auth-web's vitest) because frontend/ has no test runner; same
// cross-package arrangement as the other shared-spa suites.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import {
  embeddedUsbApiCanUse,
  embeddedUsbLogsModel,
  usbBootsel,
} from "../../../../../../frontend/src/models/embeddedUsbLogsModel";

const FRAME_ID = 7;

/** A Pico's USB CDC port: answers whatever `respond` says to each line written. */
class FakeSerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  written: string[] = [];
  opens = 0;
  closes = 0;
  connected = true;

  constructor(private respond: (line: string) => string) {}

  open(): Promise<void> {
    this.opens += 1;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    this.readable = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        const line = new TextDecoder().decode(chunk);
        this.written.push(line);
        controller?.enqueue(new TextEncoder().encode(this.respond(line)));
      },
    });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closes += 1;
    this.readable = null;
    this.writable = null;
    return Promise.resolve();
  }

  getInfo(): { usbVendorId: number; usbProductId: number } {
    // Raspberry Pi's USB vendor id; the pico-sdk CDC product id.
    return { usbVendorId: 0x2e8a, usbProductId: 0x000a };
  }
}

function installSerial(ports: FakeSerialPort[]): { getPorts: ReturnType<typeof vi.fn> } {
  const serial = { getPorts: vi.fn(() => Promise.resolve(ports)), requestPort: vi.fn() };
  Object.defineProperty(navigator, "serial", { value: serial, configurable: true });
  return serial;
}

function streamStatus(): string | undefined {
  return embeddedUsbLogsModel.values.usbLogStreamStatesByFrameId[FRAME_ID]?.status;
}

function usbLogLines(): string[] {
  return (embeddedUsbLogsModel.values.usbLogsByFrameId[FRAME_ID] ?? []).map((log) => log.line);
}

describe("usbBootsel", () => {
  beforeEach(() => {
    initKea();
    embeddedUsbLogsModel.mount();
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "serial");
  });

  it("sends `usb_api bootsel`, resolves on the ack and ends the USB session", async () => {
    const port = new FakeSerialPort(() => "rebooting into BOOTSEL mode\r\n__FRAMEOS_USB_OK__ bootsel\r\n");
    const serial = installSerial([port]);

    await usbBootsel(FRAME_ID, { port: port as unknown as SerialPort });

    expect(port.written).toEqual(["usb_api bootsel\n"]);
    // The port is closed and forgotten: the board is a USB drive now, and the
    // next USB action has to ask for a port again rather than open a dead one.
    expect(port.readable).toBeNull();
    expect(port.closes).toBeGreaterThan(0);
    expect(embeddedUsbApiCanUse(FRAME_ID)).toBe(false);
    expect(streamStatus()).toBe("idle");
    // No reconnect loop ran: `restart` would have said the device is rebooting
    // and polled getPorts() for a replacement (it is only consulted once, up
    // front, to decide whether a reconnect would even be unambiguous).
    expect(usbLogLines().some((line) => /waiting for the USB port to come back/i.test(line))).toBe(false);
    expect(usbLogLines().some((line) => /left the USB serial bus/i.test(line))).toBe(true);
    expect(serial.getPorts.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("reports a firmware that has no such verb instead of pretending it rebooted", async () => {
    // The ESP32 firmware (and a Pico build that predates the verb).
    const port = new FakeSerialPort(
      () => "__FRAMEOS_USB_ERROR__ bootsel ESP_ERR_NOT_SUPPORTED unknown usb_api subcommand\r\n",
    );
    installSerial([port]);

    await expect(usbBootsel(FRAME_ID, { port: port as unknown as SerialPort })).rejects.toThrow(
      /ESP_ERR_NOT_SUPPORTED/,
    );
    // A refusal is not a disconnect: the board is still there and still usable.
    expect(embeddedUsbApiCanUse(FRAME_ID)).toBe(true);
    expect(usbLogLines().some((line) => /left the USB serial bus/i.test(line))).toBe(false);
  });
});
