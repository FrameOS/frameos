// @vitest-environment jsdom
//
// A Pico W / Pico 2 W frame (Pimoroni Inky Frame) in the self-hosted deploy
// drawer: step 1 is a download of the release .uf2 through the backend, step 2
// is the same "Connect over USB" card an ESP32 gets — minus everything that
// ends in esptool, which cannot write a Pico's flash. These render both cards
// over a mocked backend and a mocked USB console and pin what a person is
// offered: the download (or an honest "this release has none"), "flash the UF2
// first" for a silent board instead of the ESP32 browser flasher, and "Reboot
// into BOOTSEL" where an ESP32 has "Update firmware, keep settings".
//
// Lives here (auth-web's vitest) because frontend/ has no test runner; same
// cross-package arrangement as the other shared-spa suites.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { embeddedUsbLogsModel } from "../../../../../../frontend/src/models/embeddedUsbLogsModel";
import { EmbeddedUsbConnect } from "../../../../../../frontend/src/scenes/workspace/EmbeddedUsbConnect";
import { PicoFirmwareCard } from "../../../../../../frontend/src/scenes/workspace/PicoFirmwareCard";
import type { FrameType } from "../../../../../../frontend/src/types";

// The USB console as the card reaches it: `status` is the only command these
// tests let through, answered by whatever the test says the board is.
const runCommandMock = vi.hoisted(() => vi.fn<(frameId: number, command: string) => Promise<{ text?: string }>>());
vi.mock("../../../../../../frontend/src/models/embeddedUsbLogsModel", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runEmbeddedUsbApiCommand: runCommandMock };
});

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string) => apiFetchMock(input) };
});

const downloadBlobMock = vi.hoisted(() => vi.fn<(blob: Blob, fileName: string) => void>());
vi.mock("../../../../../../frontend/src/utils/objectUrl", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, downloadBlob: downloadBlobMock };
});

const FRAME_ID = 1;

function picoFrame(): FrameType {
  return {
    id: FRAME_ID as unknown as FrameType["id"],
    project_id: 1,
    name: "Hallway Inky",
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
    device: "waveshare.EPD_7in3e",
    embedded: { platform: "pico-2w", hardwarePreset: "pimoroni_inky_frame_7_3_spectra" },
  } as FrameType;
}

// GET /api/frames/{id}/embedded/provisioning for a pico frame, 2026-09.
const provisioning = {
  supported: true,
  platform: "pico-2w",
  releasePlatform: "pico-2w",
  releaseFlashSize: "4MB",
  releaseFormat: "uf2",
  blockers: [],
  warnings: [],
  settings: [
    { key: "hardware", value: "pimoroni_inky_frame_7_3_spectra", secret: false },
    { key: "backend", value: "http://10.0.0.5:8989", secret: false },
    { key: "frame_id", value: "1", secret: false },
  ],
  wifi: { ssid: "Home WiFi", password: "hunter2" },
};

const picoAssets = [
  { name: "frameos-v2026.9.20-pico-w.uf2", platform: "pico-w", size: 1_480_704, format: "uf2" },
  { name: "frameos-v2026.9.20-pico-2w.uf2", platform: "pico-2w", size: 1_512_448, format: "uf2" },
];

function mockBackendApi(assets: unknown[]) {
  apiFetchMock.mockImplementation((input: string) => {
    const url = String(input);
    if (url === `/api/frames/${FRAME_ID}/embedded/provisioning`) {
      return Promise.resolve(Response.json({ provisioning }));
    }
    if (url === "/api/frames/firmware") {
      return Promise.resolve(
        Response.json({
          release: "v2026.9.20",
          assets: [
            { name: "frameos-v2026.9.20-esp32-s3-generic.bin", platform: "esp32-s3-generic", size: 3_400_000, format: "bin" },
            ...assets,
          ],
        }),
      );
    }
    if (url === "/api/frames/firmware?platform=pico-2w") {
      return Promise.resolve(
        new Response(new Uint8Array([0x55, 0x46, 0x32, 0x0a]), {
          headers: {
            "content-disposition": 'attachment; filename="frameos-v2026.9.20-pico-2w.uf2"',
            "x-frameos-image-name": "frameos-v2026.9.20-pico-2w.uf2",
          },
        }),
      );
    }
    return Promise.resolve(new Response("null", { status: 404 }));
  });
}

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;

beforeEach(() => {
  // Backend mode: no FRAMEOS_APP_CONFIG.cloudMode. The flag keeps anything
  // that slips past the apiFetch mock off the network.
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  runCommandMock.mockReset();
  downloadBlobMock.mockReset();
  Object.defineProperty(navigator, "serial", {
    configurable: true,
    value: { getPorts: () => Promise.resolve([]), requestPort: () => Promise.reject(new Error("no port in tests")) },
  });
  initKea();
  embeddedUsbLogsModel.mount();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "serial");
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

/** Mark the frame's USB session as streaming, which is what arms the card's probe. */
function connectBoard(): void {
  embeddedUsbLogsModel.actions.setUsbLogStreamState(FRAME_ID, { status: "streaming" });
}

describe("PicoFirmwareCard", () => {
  it("downloads the release .uf2 through the backend, named by the response", async () => {
    mockBackendApi(picoAssets);
    render(<PicoFirmwareCard frame={picoFrame()} />);

    const button = await screen.findByRole("button", { name: /download firmware \(\.uf2\)/i });
    // Which file, which release, how big — from the listing.
    expect(screen.getByText(/frameos-v2026\.9\.20-pico-2w\.uf2 · FrameOS 2026\.9\.20 · 1\.4 MB/)).toBeTruthy();
    // The steps name the drive this chip's bootloader mounts as.
    expect(screen.getByText("RP2350")).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    expect(downloadBlobMock.mock.calls[0]?.[1]).toBe("frameos-v2026.9.20-pico-2w.uf2");
    expect(apiFetchMock.mock.calls.map(([url]) => url)).toContain("/api/frames/firmware?platform=pico-2w");
    await screen.findByText(/saved frameos-v2026\.9\.20-pico-2w\.uf2/i);
  });

  it("says so when the latest release predates the pico build, and points at GitHub", async () => {
    mockBackendApi([]);
    render(<PicoFirmwareCard frame={picoFrame()} />);

    await screen.findByText(/does not publish a pico-2w/i);
    expect(screen.queryByRole("button", { name: /download firmware/i })).toBeNull();
    const link = screen.getByRole("link", { name: /github releases page/i });
    expect(link.getAttribute("href")).toBe("https://github.com/FrameOS/frameos/releases/latest");
    // The steps are still there: the file can come from anywhere.
    expect(screen.getByText("RP2350")).toBeTruthy();
  });

  it("falls back to GitHub when the listing cannot be fetched at all", async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve(new Response("null", { status: 502 })));
    render(<PicoFirmwareCard frame={picoFrame()} />);
    await screen.findByText(/could not look up the latest FrameOS release/i);
    expect(screen.getByRole("link", { name: /github releases page/i })).toBeTruthy();
  });
});

describe("EmbeddedUsbConnect on a Pico frame", () => {
  it("is step 2, and promises no flashing", () => {
    mockBackendApi(picoAssets);
    render(<EmbeddedUsbConnect frame={picoFrame()} />);
    expect(screen.getByText("2. Connect over USB and apply settings")).toBeTruthy();
    expect(screen.queryByText(/flash a blank board/i)).toBeNull();
    expect(screen.getByRole("button", { name: /connect over usb/i })).toBeTruthy();
  });

  it("sends a silent board back to step 1 instead of offering the ESP32 browser flasher", async () => {
    mockBackendApi(picoAssets);
    runCommandMock.mockRejectedValue(new Error("Timed out waiting for USB command response: status"));
    render(<EmbeddedUsbConnect frame={picoFrame()} />);
    connectBoard();

    await screen.findByText(/flash the UF2 first \(step 1\)/i);
    expect(screen.queryByRole("button", { name: /flash frameos/i })).toBeNull();
    expect(screen.queryByText(/flash frameos onto it/i)).toBeNull();
  });

  it("offers settings and BOOTSEL to a board that is this frame — no esptool anywhere", async () => {
    mockBackendApi(picoAssets);
    runCommandMock.mockResolvedValue({
      text: JSON.stringify({
        app: "frameos-pico",
        version: "2026.9.18",
        board: { target: "pico-2w", module: "pico2_w", display: "EPD_7in3e" },
        wifi: { state: 2, ip: "10.0.0.77", rssi: -58, timeSynced: true },
        cloud: { state: "unsupported", url: "", frameId: "", wsConnected: false, error: "" },
        config: { frameId: FRAME_ID, panel: "EPD_7in3e", backendUrl: "http://10.0.0.5:8989", wifiSsid: "Home WiFi" },
      }),
    });
    render(<EmbeddedUsbConnect frame={picoFrame()} manualFlashCommand="esptool.py write_flash 0x0 frameos.bin" />);
    connectBoard();

    await screen.findByText(/this board is “Hallway Inky”/i);
    // The board is a release behind: the update on offer is the BOOTSEL reboot.
    expect(screen.getByRole("button", { name: /reboot into bootsel/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /apply frame settings/i })).toBeTruthy();
    for (const esp32Only of [/update firmware, keep settings/i, /erase & flash frameos again/i, /copy flash command/i]) {
      expect(screen.queryByRole("button", { name: esp32Only })).toBeNull();
    }
    expect(screen.queryByText(/esptool/i)).toBeNull();
  });

  it("refuses to write this frame onto a board of the other family", async () => {
    mockBackendApi(picoAssets);
    runCommandMock.mockResolvedValue({
      text: JSON.stringify({
        app: "frameos",
        version: "2026.9.18",
        board: { target: "esp32s3", module: "", display: "" },
        config: { frameId: 0, backendUrl: "" },
      }),
    });
    render(<EmbeddedUsbConnect frame={picoFrame()} />);
    connectBoard();

    await screen.findByText(/reports itself as esp32s3/i);
    expect(screen.queryByRole("button", { name: /set up as this frame/i })).toBeNull();
  });
});
