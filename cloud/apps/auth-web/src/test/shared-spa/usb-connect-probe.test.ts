// @vitest-environment jsdom
//
// The "Connect over USB" card reads the board once per USB session. The probe
// stops and restarts the log stream like any USB command, and the card used to
// take that as an unplug and probe again, every 8 s, forever (2026-10-09).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import {
  embeddedUsbLogsModel,
  startEmbeddedUsbLogStream,
  stopEmbeddedUsbLogStream,
} from "../../../../../../frontend/src/models/embeddedUsbLogsModel";
import { embeddedUsbConnectLogic } from "../../../../../../frontend/src/scenes/workspace/embeddedUsbConnectLogic";
import type { FrameId, FrameType } from "../../../../../../frontend/src/types";

vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: () => Promise.reject(new Error("no backend in this test")) };
});

const frameId = 7 as unknown as FrameId;

function embeddedFrame(): FrameType {
  return {
    id: frameId,
    name: "Bench frame",
    mode: "embedded",
    frame_host: "",
    scenes: [],
    embedded: { platform: "esp32-s3" },
  } as unknown as FrameType;
}

// A board that never answers, or answers `usb_api status` with a FrameOS
// status. Web Serial's shape: readable/writable exist only while the port is
// open, and a cancelled readable is replaced on the next access.
class FakePort {
  connected = true;
  opens = 0;
  commands: string[] = [];
  private isOpen = false;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private currentReadable: ReadableStream<Uint8Array> | null = null;
  private currentWritable: WritableStream<Uint8Array> | null = null;

  constructor(private readonly status: Record<string, unknown> | null) {}

  getInfo() {
    return { usbVendorId: 0x303a, usbProductId: 0x1001 };
  }

  async open() {
    if (this.isOpen) {
      throw new Error("The port is already open.");
    }
    this.isOpen = true;
    this.opens += 1;
  }

  async close() {
    this.isOpen = false;
    this.currentReadable = null;
    this.currentWritable = null;
    this.controller = null;
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
        const line = new TextDecoder().decode(chunk).trim();
        this.commands.push(line);
        if (line === "usb_api status" && this.status) {
          const body = JSON.stringify(this.status);
          this.controller?.enqueue(
            new TextEncoder().encode(
              `__FRAMEOS_USB_BEGIN__ status ${body.length} text\n${body}\n__FRAMEOS_USB_END__ status\n`,
            ),
          );
        }
      },
    });
    return this.currentWritable;
  }

  statusCommands(): number {
    return this.commands.filter((line) => line === "usb_api status").length;
  }
}

function useBoard(port: FakePort) {
  Object.defineProperty(navigator, "serial", {
    configurable: true,
    value: { requestPort: async () => port, getPorts: async () => [port] },
  });
}

function usbLogLines(): string[] {
  return (embeddedUsbLogsModel.values.usbLogsByFrameId[frameId] ?? []).map((log) => log.line);
}

describe("Connect over USB: the board is read once per session", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    initKea();
    unmount = embeddedUsbConnectLogic({ frameId, frame: embeddedFrame() }).mount();
  });

  afterEach(async () => {
    await stopEmbeddedUsbLogStream(frameId);
    unmount?.();
    vi.useRealTimers();
  });

  it("a board that never answers is read once and settles as silent", async () => {
    const port = new FakePort(null);
    useBoard(port);
    const logic = embeddedUsbConnectLogic({ frameId, frame: embeddedFrame() });

    await startEmbeddedUsbLogStream(frameId, port as unknown as SerialPort);
    // Several probe timeouts' worth: the old loop sent a status every 8 s.
    await vi.advanceTimersByTimeAsync(45000);

    expect(port.statusCommands()).toBe(1);
    // Every reopen toggles DTR/RTS and resets the board.
    expect(port.opens).toBe(1);
    expect(usbLogLines().filter((line) => line.includes("waiting for previous USB command"))).toEqual([]);
    expect(logic.values.probing).toBe(false);
    expect(logic.values.identity?.kind).toBe("silent");
    // The stream is back and the card stays connected, offering the flash.
    expect(logic.values.connected).toBe(true);
    expect(logic.values.streaming).toBe(true);
  });

  it("a FrameOS board is read once and identified", async () => {
    const port = new FakePort({ version: "2026.10.0", config: { frameId: 0, backendUrl: "" }, cloud: { frameId: "" } });
    useBoard(port);
    const logic = embeddedUsbConnectLogic({ frameId, frame: embeddedFrame() });

    await startEmbeddedUsbLogStream(frameId, port as unknown as SerialPort);
    await vi.advanceTimersByTimeAsync(30000);

    expect(port.statusCommands()).toBe(1);
    expect(logic.values.identity?.kind).toBe("unprovisioned");
    expect(logic.values.connected).toBe(true);
  });

  it("disconnecting ends the session; reconnecting reads the board again", async () => {
    const port = new FakePort(null);
    useBoard(port);
    const logic = embeddedUsbConnectLogic({ frameId, frame: embeddedFrame() });

    await startEmbeddedUsbLogStream(frameId, port as unknown as SerialPort);
    await vi.advanceTimersByTimeAsync(10000);
    expect(logic.values.identity?.kind).toBe("silent");

    await stopEmbeddedUsbLogStream(frameId);
    expect(logic.values.connected).toBe(false);
    expect(logic.values.identity).toBeNull();
    expect(logic.values.probed).toBe(false);

    await startEmbeddedUsbLogStream(frameId, port as unknown as SerialPort);
    await vi.advanceTimersByTimeAsync(10000);
    expect(port.statusCommands()).toBe(2);
    expect(logic.values.identity?.kind).toBe("silent");
  });

  it("'Read the board again' sends exactly one more status", async () => {
    const port = new FakePort(null);
    useBoard(port);
    const logic = embeddedUsbConnectLogic({ frameId, frame: embeddedFrame() });

    await startEmbeddedUsbLogStream(frameId, port as unknown as SerialPort);
    await vi.advanceTimersByTimeAsync(10000);
    logic.actions.recheck();
    await vi.advanceTimersByTimeAsync(30000);

    expect(port.statusCommands()).toBe(2);
    expect(logic.values.identity?.kind).toBe("silent");
  });
});
