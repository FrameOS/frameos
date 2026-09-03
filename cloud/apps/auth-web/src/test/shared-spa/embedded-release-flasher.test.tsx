// @vitest-environment jsdom
//
// The self-hosted backend's "Flash latest release" flow: write the published
// generic image to a blank board and then tell the board what frame it is over
// the USB console, instead of compiling a per-frame image first.
//
// What these cover is the part that can silently produce a wrong frame — that
// the bytes written are the RELEASE asset (not the frame's build), that the
// provisioning commands go out in the backend's order (a hardware preset
// applies a whole board bundle, so anything overriding it must come after),
// and that a frame whose settings only exist as compile-time defaults is
// refused rather than half-provisioned.
//
// Lives here (auth-web's vitest) because frontend/ has no test runner; same
// cross-package arrangement as the other shared-spa suites.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import {
  EmbeddedReleaseFlasher,
  provisionOverUsb,
  type EmbeddedProvisioningPlan,
} from "../../../../../../frontend/src/scenes/workspace/EmbeddedReleaseFlasher";
import type { FrameType } from "../../../../../../frontend/src/types";
import { mergedImage } from "./esp32ImageFixtures";

interface WriteFlashOptions {
  eraseAll: boolean;
  fileArray: { address: number; data: Uint8Array }[];
}

// A fake esptool-js: writeFlash records its options and then throws, which
// ends the flow on the component's error path — deliberately, so the test
// never enters the post-flash boot wait, which needs a live device.
const esptool = vi.hoisted(() => {
  const state = { writeFlashCalls: [] as unknown[] };
  class FakeESPLoader {
    chip = { CHIP_NAME: "ESP32-C3" };
    constructor(_options: unknown) {}
    main() {
      return Promise.resolve("ESP32-C3");
    }
    writeFlash(options: unknown): Promise<void> {
      state.writeFlashCalls.push(options);
      return Promise.reject(new Error("test stop: write captured"));
    }
    writeReg() {
      return Promise.resolve();
    }
  }
  class FakeTransport {
    constructor(_port: unknown, _tracing: boolean) {}
    trace(_message: string) {}
    disconnect() {
      return Promise.resolve();
    }
    setDTR(_value: boolean) {
      return Promise.resolve();
    }
    setRTS(_value: boolean) {
      return Promise.resolve();
    }
  }
  return { state, module: { ESPLoader: FakeESPLoader, Transport: FakeTransport } };
});

vi.mock("../../../../../../frontend/src/scenes/workspace/esptoolLoader", () => ({
  loadEsptool: () => Promise.resolve(esptool.module),
}));

// The USB console, as the flasher reaches it. Mocked at the model so the tests
// see the command list without a serial device behind it.
const usbSetMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../../../../../frontend/src/models/embeddedUsbLogsModel", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, usbSet: usbSetMock };
});

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string) => apiFetchMock(input) };
});

const releaseImage = mergedImage();

function plan(overrides: Partial<EmbeddedProvisioningPlan> = {}): EmbeddedProvisioningPlan {
  return {
    supported: true,
    platform: "esp32-c3",
    releasePlatform: "esp32-c3-generic",
    releaseFlashSize: "4MB",
    blockers: [],
    warnings: [],
    settings: [
      { key: "hardware", value: "xteink_x4", secret: false },
      { key: "panel", value: "EPD_4in26", secret: false },
      { key: "backend", value: "http://10.0.0.5:8989", secret: false },
      { key: "api_key", value: "key-9", secret: true },
      { key: "frame_id", value: "1", secret: false },
    ],
    wifi: { ssid: "Home WiFi", password: "hunter2" },
    ...overrides,
  };
}

function embeddedC3Frame(): FrameType {
  return {
    id: 1 as unknown as FrameType["id"],
    project_id: 1,
    name: "Bench frame",
    mode: "embedded",
    frame_host: "",
    frame_port: 8787,
    frame_access_key: "",
    frame_access: "private",
    ssh_port: 22,
    server_port: 8989,
    status: "active",
    interval: 300,
    metrics_interval: 60,
    scaling_mode: "contain",
    background_color: "#000000",
    scenes: [],
    embedded: { platform: "esp32-c3" },
  } as FrameType;
}

function mockBackendApi(provisioning: EmbeddedProvisioningPlan) {
  apiFetchMock.mockImplementation((input: string) => {
    const url = String(input);
    if (url === "/api/frames/1/embedded/provisioning") {
      return Promise.resolve(Response.json({ provisioning }));
    }
    if (url === "/api/frames/firmware") {
      return Promise.resolve(
        Response.json({
          release: "v2026.8.26",
          assets: [{ name: "frameos-2026.8.26-esp32-c3-generic.bin", platform: "esp32-c3-generic", size: 1024 }],
        }),
      );
    }
    if (url.startsWith("/api/frames/firmware?platform=")) {
      return Promise.resolve(new Response(releaseImage.slice()));
    }
    return Promise.resolve(new Response("null", { status: 404 }));
  });
}

function stubSerial() {
  const port = {
    getInfo: () => ({ usbProductId: 0x1001, usbVendorId: 0x303a }),
    close: () => Promise.resolve(),
    open: () => Promise.resolve(),
    readable: null,
    writable: null,
  };
  Object.defineProperty(navigator, "serial", {
    configurable: true,
    value: {
      getPorts: () => Promise.resolve([port]),
      requestPort: () => Promise.resolve(port),
    },
  });
  return port;
}

type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as CloudTestWindow;

beforeEach(() => {
  testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  usbSetMock.mockClear();
  esptool.state.writeFlashCalls = [];
  stubSerial();
  initKea();
  framesModel.mount();
});

afterEach(() => {
  cleanup();
  delete (navigator as { serial?: unknown }).serial;
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("EmbeddedReleaseFlasher", () => {
  it("writes the published image as one image from 0x0", async () => {
    mockBackendApi(plan());
    render(<EmbeddedReleaseFlasher frame={embeddedC3Frame()} />);
    await screen.findByText(/esp32-c3-generic image/i);

    fireEvent.click(screen.getByRole("button", { name: /flash latest release/i }));
    await waitFor(() => expect(esptool.state.writeFlashCalls.length).toBe(1), { timeout: 5000 });

    const options = esptool.state.writeFlashCalls[0] as WriteFlashOptions;
    // A blank board has no settings to spare, so this is the monolithic write
    // — and the bytes are the release asset, not a per-frame build.
    expect(options.fileArray.length).toBe(1);
    expect(options.fileArray[0].address).toBe(0);
    expect(options.fileArray[0].data.byteLength).toBe(releaseImage.byteLength);
  });

  it("shows what the published image cannot carry, before anyone chooses it", async () => {
    mockBackendApi(
      plan({
        warnings: ["The published image uses the 4MB partition layout; this frame is configured for 16MB flash."],
      }),
    );
    render(<EmbeddedReleaseFlasher frame={embeddedC3Frame()} />);

    expect(await screen.findByText(/4MB partition layout/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /flash latest release/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses a frame the backend says cannot be provisioned", async () => {
    mockBackendApi(
      plan({
        supported: false,
        blockers: ["This frame has no server host set, so the device would have no backend to talk to."],
      }),
    );
    render(<EmbeddedReleaseFlasher frame={embeddedC3Frame()} />);

    expect(await screen.findByText(/cannot be flashed yet/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /flash latest release/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders nothing for a platform with no published image", async () => {
    mockBackendApi(plan({ releasePlatform: null, releaseFlashSize: null }));
    const { container } = render(<EmbeddedReleaseFlasher frame={embeddedC3Frame()} />);

    await waitFor(() => expect(container.textContent).toBe(""));
  });
});

describe("provisionOverUsb", () => {
  it("sends the backend's commands in the backend's order", async () => {
    const port = stubSerial() as unknown as SerialPort;

    await provisionOverUsb(1 as unknown as FrameType["id"], plan(), port, () => {});

    // `set hardware` applies the board bundle (panel, wiring, buttons), so a
    // frame's own panel has to be sent after it, never before.
    expect(usbSetMock.mock.calls.map((call) => call[1])).toEqual([
      "hardware",
      "panel",
      "backend",
      "api_key",
      "frame_id",
    ]);
    // The port is handed to every command and kept open: the open/close churn
    // of per-command reconnects can strap a USB-Serial/JTAG board into reset.
    expect(usbSetMock.mock.calls[0][3]).toMatchObject({ port, keepOpen: true });
  });

  it("keeps a secret's value out of the status messages", async () => {
    const port = stubSerial() as unknown as SerialPort;
    const messages: string[] = [];

    await provisionOverUsb(1 as unknown as FrameType["id"], plan(), port, (message) => messages.push(message));

    expect(messages.some((message) => message.includes("key-9"))).toBe(false);
    expect(messages.some((message) => message.includes("EPD_4in26"))).toBe(true);
  });
});
