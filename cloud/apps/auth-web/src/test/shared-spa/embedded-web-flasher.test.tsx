// @vitest-environment jsdom
//
// The self-hosted backend's "Flash from browser" flow, and specifically its
// NVS-sparing keep-settings path: when the user keeps "Keep device settings"
// ticked, the server-built merged image is written in segments AROUND its NVS
// partition (embeddedFlashImage.ts firmwareUpdateWritePlan) instead of as one
// monolithic 0x0 write — and when the board's own partition table disagrees
// with the image, the flow falls back to the full write instead of aborting,
// because the server-built image carries the frame's baked-in configuration.
//
// Lives here (auth-web's vitest) because frontend/ has no test runner; same
// cross-package arrangement as the other shared-spa suites. esptool-js drives
// real USB hardware and only resolves from frontend/'s own node_modules, so
// the flasher's loader wrapper (esptoolLoader.ts) is mocked by source path —
// the same trick cloud-esp32-flasher.test.tsx plays with the cloud flasher's
// lib/esptool wrapper.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import {
  EmbeddedWebFlasher,
  planServerFirmwareWrite,
} from "../../../../../../frontend/src/scenes/workspace/EmbeddedWebFlasher";
import type { FrameType } from "../../../../../../frontend/src/types";
import { defaultLayout, mergedImage, partitionTable } from "./esp32ImageFixtures";

interface WriteFlashOptions {
  eraseAll: boolean;
  fileArray: { address: number; data: Uint8Array }[];
}

// A fake esptool-js: the tests only care what writeFlash is asked to write.
// writeFlash records its options and then throws, which ends the flash flow on
// the component's error path — deliberately, so the test never enters the
// post-flash boot wait / scene upload tail, which needs a live device.
const esptool = vi.hoisted(() => {
  const state = {
    deviceTable: null as Uint8Array | null,
    readFlashError: null as Error | null,
    writeFlashCalls: [] as unknown[],
  };
  class FakeESPLoader {
    chip = { CHIP_NAME: "ESP32-S3" };
    constructor(_options: unknown) {}
    main() {
      return Promise.resolve("ESP32-S3");
    }
    readFlash(_address: number, _size: number): Promise<Uint8Array> {
      if (state.readFlashError) {
        return Promise.reject(state.readFlashError);
      }
      if (!state.deviceTable) {
        return Promise.reject(new Error("no fake device table configured"));
      }
      return Promise.resolve(state.deviceTable);
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

vi.mock(
  "../../../../../../frontend/src/scenes/workspace/esptoolLoader",
  () => ({ loadEsptool: () => Promise.resolve(esptool.module) }),
);

// The backend API, as the flasher sees it through apiFetch. Mocked at the
// module (rather than global fetch) so the real apiFetch's no-backend guard
// and project-path resolution stay out of the way.
const apiFetchMock = vi.hoisted(() => vi.fn<(input: string) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string) => apiFetchMock(input) };
});

const image = mergedImage();
const layoutPartitions = defaultLayout.map(({ name, offset, size }) => ({ name, offset, size }));

function backendEsp32Frame(overrides: Partial<NonNullable<FrameType["embedded"]>["firmware"]> = {}): FrameType {
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
    embedded: {
      platform: "esp32-s3",
      firmware: {
        status: "ready",
        flashOffset: "0x0",
        flashSize: "8MB",
        downloadUrl: "/api/frames/1/embedded/firmware/download",
        layout: { flash: { partitions: layoutPartitions } },
        ...overrides,
      },
    },
  } as FrameType;
}

function mockBackendApi(frame: FrameType) {
  apiFetchMock.mockImplementation((input: string) => {
    const url = String(input);
    if (url === "/api/frames/1/embedded/firmware") {
      return Promise.resolve(Response.json({ firmware: frame.embedded?.firmware ?? {} }));
    }
    if (url.startsWith("/api/frames/1/embedded/firmware/download")) {
      return Promise.resolve(
        new Response(image.slice(), {
          headers: { "content-type": "application/octet-stream" },
        }),
      );
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
}

async function clickFlashAndCaptureWrite(): Promise<WriteFlashOptions> {
  fireEvent.click(screen.getByRole("button", { name: /flash from browser/i }));
  await waitFor(() => expect(esptool.state.writeFlashCalls.length).toBe(1), {
    timeout: 5000,
  });
  return esptool.state.writeFlashCalls[0] as WriteFlashOptions;
}

// The cloud fleet UI's runtime globals (see esp32-frame-controls.test.tsx for
// why: cloudMode short-circuits apiFetch's project scoping, NO_BACKEND keeps
// socketLogic from dialing a WebSocket jsdom does not have).
type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as CloudTestWindow;

beforeEach(() => {
  testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  esptool.state.deviceTable = null;
  esptool.state.readFlashError = null;
  esptool.state.writeFlashCalls = [];
  stubSerial();
  // Fresh kea context per test; framesModel is mounted explicitly because the
  // flasher dispatches its updateEmbeddedFirmwareStatus action directly.
  initKea();
  framesModel.mount();
});

afterEach(() => {
  cleanup();
  delete (navigator as { serial?: unknown }).serial;
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("EmbeddedWebFlasher keep-settings flashing", () => {
  it("offers the keep-settings checkbox, ticked, when the firmware layout lists partitions", () => {
    render(<EmbeddedWebFlasher frame={backendEsp32Frame()} />);

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.closest("label")?.textContent).toMatch(/keep device settings/i);
  });

  it("hides the checkbox when the status payload carries no partition layout", () => {
    render(<EmbeddedWebFlasher frame={backendEsp32Frame({ layout: {} })} />);

    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("writes segments around the NVS partition when the board's table matches the image", async () => {
    const frame = backendEsp32Frame();
    mockBackendApi(frame);
    esptool.state.deviceTable = partitionTable(defaultLayout);
    render(<EmbeddedWebFlasher frame={frame} />);

    const options = await clickFlashAndCaptureWrite();

    // Two segments, with the hole exactly over the NVS (0x9000 + 16KB) — not
    // a monolithic 0x0 write.
    expect(
      options.fileArray.map((segment) => [segment.address, segment.address + segment.data.byteLength]),
    ).toEqual([
      [0, 0x9000],
      [0xd000, image.byteLength],
    ]);
    // eraseAll would take the NVS along with the whole chip.
    expect(options.eraseAll).toBe(false);
  });

  it("falls back to the monolithic write when the board is partitioned differently", async () => {
    const frame = backendEsp32Frame();
    mockBackendApi(frame);
    // Same offset, different size: the image's hole would clip this NVS.
    esptool.state.deviceTable = partitionTable(
      defaultLayout.map((partition) =>
        partition.name === "nvs" ? { ...partition, size: 24 * 1024 } : partition,
      ),
    );
    render(<EmbeddedWebFlasher frame={frame} />);

    const options = await clickFlashAndCaptureWrite();

    expect(options.fileArray).toHaveLength(1);
    expect(options.fileArray[0]!.address).toBe(0);
    expect(options.fileArray[0]!.data.byteLength).toBe(image.byteLength);
  });

  it("writes the whole image when the user unticks keep-settings", async () => {
    const frame = backendEsp32Frame();
    mockBackendApi(frame);
    esptool.state.deviceTable = partitionTable(defaultLayout);
    render(<EmbeddedWebFlasher frame={frame} />);

    fireEvent.click(screen.getByRole("checkbox"));
    const options = await clickFlashAndCaptureWrite();

    expect(options.fileArray).toHaveLength(1);
    expect(options.fileArray[0]!.address).toBe(0);
    expect(options.fileArray[0]!.data.byteLength).toBe(image.byteLength);
  });

  it("trusts the image's own layout when the board's table cannot be read", async () => {
    const frame = backendEsp32Frame();
    mockBackendApi(frame);
    esptool.state.readFlashError = new Error("read_flash unsupported on this stub");
    render(<EmbeddedWebFlasher frame={frame} />);

    const options = await clickFlashAndCaptureWrite();

    // Matches EmbeddedUsbFirmwareUpdate: an unreadable table is not a
    // mismatch — the guarantee then rests on the image alone.
    expect(options.fileArray).toHaveLength(2);
    expect(options.fileArray.map((segment) => segment.address)).toEqual([0, 0xd000]);
  });
});

describe("planServerFirmwareWrite", () => {
  const noLoader = {};
  const log = () => {};

  it("keeps the full write for images that flash at an offset other than 0x0", async () => {
    const plan = await planServerFirmwareWrite({
      firmware: image,
      flashOffset: 0x10000,
      keepSettings: true,
      loader: noLoader,
      log,
    });

    expect(plan.fileArray).toEqual([{ address: 0x10000, data: image }]);
    expect(plan.warning).toMatch(/0x10000/);
    expect(plan.preserved).toBeUndefined();
  });

  it("falls back with a warning when the image itself has no partition table", async () => {
    const bare = new Uint8Array(0x20000);

    const plan = await planServerFirmwareWrite({
      firmware: bare,
      flashOffset: 0,
      keepSettings: true,
      loader: noLoader,
      log,
    });

    expect(plan.fileArray).toEqual([{ address: 0, data: bare }]);
    expect(plan.warning).toMatch(/no readable partition table/i);
  });

  it("builds the segment plan without a device cross-check when the loader cannot read flash", async () => {
    const plan = await planServerFirmwareWrite({
      firmware: image,
      flashOffset: 0,
      keepSettings: true,
      loader: noLoader,
      log,
    });

    expect(plan.preserved).toMatchObject({ name: "nvs", size: 16 * 1024 });
    expect(plan.fileArray.map((segment) => segment.address)).toEqual([0, 0xd000]);
    expect(plan.totalBytes).toBe(image.byteLength - 16 * 1024);
  });
});
