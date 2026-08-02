// @vitest-environment jsdom
//
// The ESP32 browser flasher inside the workspace's "Add frame" panel. It lives
// in cloud-frontend/, which has no test runner, so it is tested from auth-web's
// vitest across the package boundary (see the other shared-spa tests).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Esp32CloudFlasher,
  wifiInputError,
} from "../../../../../../cloud-frontend/src/components/Esp32CloudFlasher";

// esptool-js drives real USB hardware; the tests only care that the flasher
// calls it, hands the port back, and provisions afterwards.
const esptool = vi.hoisted(() => {
  const calls = {
    disconnects: 0,
    main: vi.fn(() => Promise.resolve()),
    writeFlash: vi.fn(() => Promise.resolve()),
  };
  return {
    calls,
    module: {
      ESPLoader: class {
        chip = { CHIP_NAME: "ESP32-S3" };
        after() {
          return Promise.resolve();
        }
        main() {
          return calls.main();
        }
        writeFlash() {
          return calls.writeFlash();
        }
      },
      Transport: class {
        disconnect() {
          calls.disconnects += 1;
          return Promise.resolve();
        }
      },
    },
  };
});

// Mocked through the flasher's own loader module, not the bare "esptool-js"
// specifier: this package does not depend on esptool-js, so the specifier
// would resolve somewhere else (or nowhere) and the real driver would load.
vi.mock("../../../../../../cloud-frontend/src/lib/esptool", () => ({
  loadEsptool: () => Promise.resolve(esptool.module),
}));

const fetchMock = vi.fn<typeof fetch>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const firmwareBytes = new Uint8Array(64).fill(0xa5);
const metadataPayload = {
  assets: [
    {
      name: "frameos-1.2.3-esp32-s3-epd7in5v2.bin",
      platform: "esp32-s3-epd7in5v2",
      size: firmwareBytes.length,
    },
    {
      name: "frameos-1.2.3-raspberry-pi-zero-2-w-buildroot.img.gz",
      platform: "raspberry-pi-zero-2-w",
      size: 1024,
    },
  ],
  release: "v1.2.3",
};

interface FakePort {
  close(): Promise<void>;
  closes: number;
  open(options: { baudRate: number }): Promise<void>;
  push(text: string): void;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  writes: string[];
}

// A serial port whose console answers scripted replies. `onOpen` decides what
// the "device" does when the flasher reopens the port for provisioning.
function createPort(options: {
  onCommand?: (port: FakePort, command: string) => void;
  onOpen?: (port: FakePort, controls: { endStream(): void }) => void;
}): FakePort {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const port: FakePort = {
    close: () => {
      port.closes += 1;
      return Promise.resolve();
    },
    closes: 0,
    open: () => {
      port.readable = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
        },
      });
      port.writable = new WritableStream<Uint8Array>({
        write(chunk) {
          const command = decoder.decode(chunk).trim();
          port.writes.push(command);
          options.onCommand?.(port, command);
        },
      });
      options.onOpen?.(port, {
        endStream: () => {
          controller?.close();
        },
      });
      return Promise.resolve();
    },
    push: (text) => {
      controller?.enqueue(encoder.encode(text));
    },
    readable: null,
    writable: null,
    writes: [],
  };
  return port;
}

// A healthy device: prompt after boot, prompt after every `set`, and the
// reboot acknowledgement for `wifi`/`restart`.
function createHealthyPort(): FakePort {
  return createPort({
    onCommand: (port, command) => {
      if (command.startsWith("wifi ") || command === "restart") {
        port.push("wifi credentials saved, restarting...\n");
        return;
      }
      port.push("ok: set\nframeos>");
    },
    onOpen: (port) => {
      port.push("boot log…\nframeos>");
    },
  });
}

function stubSerial(port: FakePort) {
  Object.defineProperty(navigator, "serial", {
    configurable: true,
    value: { requestPort: () => Promise.resolve(port) },
  });
}

function mockCloudApi(
  firmware: () => Promise<Response> = () =>
    Promise.resolve(
      new Response(firmwareBytes.slice(), {
        headers: { "content-type": "application/octet-stream" },
      }),
    ),
) {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/frames/firmware") {
      return Promise.resolve(Response.json(metadataPayload));
    }
    if (url.startsWith("/api/frames/firmware?")) {
      return firmware();
    }
    if (url === "/api/frames/claim-tokens") {
      return Promise.resolve(Response.json({ claim_token: "FRCT_minted" }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function fetchedUrls() {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

function clickFlash() {
  fireEvent.click(screen.getByRole("button", { name: /connect & flash/i }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  esptool.calls.main.mockReset();
  esptool.calls.main.mockImplementation(() => Promise.resolve());
  esptool.calls.writeFlash.mockReset();
  esptool.calls.writeFlash.mockImplementation(() => Promise.resolve());
  esptool.calls.disconnects = 0;
  vi.unstubAllGlobals();
  delete (navigator as { serial?: unknown }).serial;
});

describe("wifiInputError", () => {
  it("rejects line breaks and control characters that would inject a second command", () => {
    expect(wifiInputError("MyNet\nrestart", "")).toMatch(/line breaks/);
    expect(wifiInputError("MyNet", "hunter2\r")).toMatch(/line breaks/);
    expect(wifiInputError("MyNet\u0007", "")).toMatch(/line breaks/);
  });

  it("accepts spaces — the device console understands quoted arguments", () => {
    expect(wifiInputError("My Home WiFi", "pass phrase")).toBeUndefined();
  });

  it("enforces the 802.11 length limits", () => {
    expect(wifiInputError("x".repeat(33), "")).toMatch(/at most 32/);
    expect(wifiInputError("MyNet", "x".repeat(65))).toMatch(/at most 64/);
  });
});

describe("Esp32CloudFlasher", () => {
  it("falls back to the manual instructions without WebSerial", () => {
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    expect(screen.getByText(/needs WebSerial/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /connect & flash/i })).toBeNull();
  });

  it("refuses control characters in the WiFi fields before touching the network", async () => {
    mockCloudApi();
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await screen.findByRole("button", { name: /connect & flash/i });

    // jsdom's value sanitization strips CR/LF from text inputs, so the paste
    // that reaches state here is another control character; wifiInputError
    // covers the newline case directly.
    fireEvent.change(screen.getByLabelText("WiFi network"), {
      target: { value: "My\u0007Net" },
    });
    clickFlash();

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/line breaks or control characters/),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flashes and provisions using only same-origin requests, quoting WiFi values", async () => {
    mockCloudApi();
    const port = createHealthyPort();
    stubSerial(port);
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} frameName="Kitchen" />);
    await screen.findByRole("button", { name: /connect & flash/i });

    fireEvent.change(screen.getByLabelText("WiFi network"), {
      target: { value: "My Home WiFi" },
    });
    fireEvent.change(screen.getByLabelText("WiFi password"), {
      target: { value: 'pa ss"word' },
    });
    clickFlash();

    await screen.findByTestId("esp32-flash-done", undefined, { timeout: 5000 });

    // Never GitHub: the release redirect has no CORS headers and the API is
    // rate-limited per IP.
    expect(
      fetchedUrls().filter((url) => /github/.test(url)),
    ).toHaveLength(0);
    expect(fetchedUrls()).toContain("/api/frames/firmware");
    expect(fetchedUrls()).toContain(
      "/api/frames/firmware?platform=esp32-s3-epd7in5v2",
    );
    expect(esptool.calls.writeFlash).toHaveBeenCalledOnce();
    expect(esptool.calls.disconnects).toBe(1);

    // Spaces survive because the value is quoted; the embedded quote is escaped.
    expect(port.writes).toEqual([
      `set cloud_url "${window.location.origin}"`,
      'set claim_token "FRCT_minted"',
      'wifi "My Home WiFi" "pa ss\\"word"',
    ]);
    // The claim token is minted once, and only after the flash succeeded.
    expect(
      fetchedUrls().filter((url) => url === "/api/frames/claim-tokens"),
    ).toHaveLength(1);
  });

  it("restarts the board when no WiFi is given, without waiting for output it never prints", async () => {
    mockCloudApi();
    const port = createHealthyPort();
    stubSerial(port);
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await screen.findByRole("button", { name: /connect & flash/i });

    clickFlash();

    await screen.findByTestId("esp32-flash-done", undefined, { timeout: 5000 });
    expect(port.writes.at(-1)).toBe("restart");
  });

  it("does not burn a single-use claim token when the firmware download fails", async () => {
    mockCloudApi(() =>
      Promise.resolve(
        Response.json({ error: "firmware_download_failed" }, { status: 502 }),
      ),
    );
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await screen.findByRole("button", { name: /connect & flash/i });

    clickFlash();

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/Firmware download failed \(502\)/),
    );
    expect(fetchedUrls()).not.toContain("/api/frames/claim-tokens");
    expect(screen.queryByTestId("esp32-flash-done")).toBeNull();
  });

  it("fails loudly when the flashed firmware never shows a console prompt", async () => {
    mockCloudApi();
    // Device never speaks: the stream ends without a prompt.
    stubSerial(
      createPort({
        onOpen: (_port, controls) => {
          controls.endStream();
        },
      }),
    );
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await screen.findByRole("button", { name: /connect & flash/i });

    clickFlash();

    expect(
      await screen.findByRole("alert", undefined, { timeout: 5000 }),
    ).toHaveProperty(
      "textContent",
      expect.stringMatching(/never showed its FrameOS console prompt/),
    );
    expect(screen.queryByTestId("esp32-flash-done")).toBeNull();
  });

  it("recovers from a flash that drops part-way by retrying slower", async () => {
    // Writing 3 MB over USB serial fails mid-way on a marginal cable or hub
    // ("Failed to write compressed data to flash after seq N"). The firmware is
    // fine, so a single hiccup must not end the install.
    mockCloudApi();
    esptool.calls.writeFlash.mockRejectedValueOnce(new Error("flash write failed"));
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await screen.findByRole("button", { name: /connect & flash/i });

    clickFlash();

    await screen.findByTestId("esp32-flash-done", undefined, { timeout: 5000 });
    expect(esptool.calls.writeFlash).toHaveBeenCalledTimes(2);
    // One disconnect per attempt: the retry has to reopen the same port.
    expect(esptool.calls.disconnects).toBe(2);
  });

  it("gives up with something actionable when every attempt fails", async () => {
    mockCloudApi();
    esptool.calls.writeFlash.mockRejectedValue(new Error("flash write failed"));
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await screen.findByRole("button", { name: /connect & flash/i });

    clickFlash();

    const alert = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alert).toHaveProperty(
      "textContent",
      expect.stringMatching(/flash write failed/),
    );
    // "It failed" is useless on its own — the causes are physical.
    expect(alert.textContent).toMatch(/USB cable/);
    // The port went back to the browser after every attempt, so a manual retry
    // can reopen it.
    expect(esptool.calls.disconnects).toBe(3);
    // Nothing enrolled: claim codes are single-use, so a failed flash must not
    // spend one.
    expect(fetchedUrls()).not.toContain("/api/frames/claim-tokens");
  });
});
