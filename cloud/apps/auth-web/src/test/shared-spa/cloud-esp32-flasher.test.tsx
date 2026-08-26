// @vitest-environment jsdom
//
// The ESP32 browser flasher inside the workspace's "Add frame" panel. It lives
// in cloud-frontend/, which has no test runner, so it is tested from auth-web's
// vitest across the package boundary (see the other shared-spa tests).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeSerialPort,
  Esp32CloudFlasher,
  pinsSpecError,
  wifiInputError,
} from "../../../../../../cloud-frontend/src/components/Esp32CloudFlasher";
import { resetReleaseListingCacheForTests } from "../../../../../../cloud-frontend/src/lib/release-lookup";

// esptool-js drives real USB hardware; the tests only care that the flasher
// calls it, hands the port back, and provisions afterwards.
const esptool = vi.hoisted(() => {
  const calls = {
    disconnects: 0,
    main: vi.fn(() => Promise.resolve()),
    writeFlash: vi.fn((_options: unknown) => Promise.resolve()),
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
        writeFlash(options: unknown) {
          return calls.writeFlash(options);
        }
        // The post-flash reset pokes RTC watchdog registers over the stub
        // protocol (watchdogResetAfterFlash) instead of pulsing DTR/RTS.
        writeReg() {
          return Promise.resolve();
        }
      },
      Transport: class {
        disconnect() {
          calls.disconnects += 1;
          return Promise.resolve();
        }
        setDTR() {
          return Promise.resolve();
        }
        setRTS() {
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
// Current releases publish the all-panels build plus a transitional copy
// under the old single-panel name (docker-publish-multi.yml esp32 job).
const metadataPayload = {
  assets: [
    {
      name: "frameos-1.2.3-esp32-s3-generic.bin",
      platform: "esp32-s3-generic",
      size: firmwareBytes.length,
    },
    {
      name: "frameos-1.2.3-esp32-s3-epd7in5v2.bin",
      platform: "esp32-s3-epd7in5v2",
      size: firmwareBytes.length,
    },
    {
      name: "frameos-1.2.3-esp32-c3-generic.bin",
      platform: "esp32-c3-generic",
      size: firmwareBytes.length,
    },
    {
      name: "frameos-1.2.3-raspberry-pi-64-buildroot.img.gz",
      platform: "raspberry-pi-64",
      size: 1024,
    },
  ],
  release: "v1.2.3",
};
// A release from before the runtime panel table shipped.
const legacyMetadataPayload = {
  assets: metadataPayload.assets.filter(
    (asset) => asset.platform !== "esp32-s3-generic",
  ),
  release: "v1.0.0",
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
  metadata: typeof metadataPayload = metadataPayload,
  // The enrollment watcher's frames-list snapshot/polling. Defaults to an
  // account with no frames that never gains one.
  frames: () => unknown[] = () => [],
) {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/frames/firmware") {
      return Promise.resolve(Response.json(metadata));
    }
    if (url.startsWith("/api/frames/firmware?")) {
      return firmware();
    }
    if (url === "/api/frames/claim-tokens") {
      return Promise.resolve(Response.json({ claim_token: "FRCT_minted" }));
    }
    if (url === "/api/frames") {
      return Promise.resolve(Response.json({ frames: frames() }));
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

// A frame name and a hardware choice are both required before flashing (there
// is no default board any more). Fill them the way a real flash would.
async function fillRequiredFields(hardware = "panel:EPD_7in5_V2") {
  fireEvent.change(screen.getByLabelText("Frame name"), {
    target: { value: "Kitchen" },
  });
  fireEvent.change(await screen.findByLabelText("Frame hardware"), {
    target: { value: hardware },
  });
}

beforeEach(() => {
  // The listing is memoised in the browser; each test mocks its own release.
  resetReleaseListingCacheForTests();
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

describe("describeSerialPort", () => {
  it("names a USB-UART bridge and where the console answers on it", () => {
    // Seeed's reTerminal E10xx wires USB-C to a CH340 ("USB Single Serial",
    // WCH vendor id) on UART0 and nothing to the chip's own USB pins; the
    // PhotoPainter 13.3" shows a CH343 next to the JTAG port. The firmware
    // console answers on UART0 too, so the log names the port kind and the
    // baud rate instead of refusing it.
    expect(describeSerialPort({ usbVendorId: 0x1a86 })).toMatch(
      /WCH.*UART0 at 115200 baud/,
    );
    expect(describeSerialPort({ usbVendorId: 0x10c4 })).toMatch(/CP210x/);
  });

  it("recognises the Espressif built-in USB device and ports without USB info", () => {
    expect(describeSerialPort({ usbVendorId: 0x303a })).toMatch(
      /built-in USB-Serial\/JTAG/,
    );
    expect(describeSerialPort({})).toBe("a serial port");
    expect(describeSerialPort(undefined)).toBe("a serial port");
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
    // Only the mount-time release listing probe (for the panel picker) may
    // have fired — validation must run before anything else touches the
    // network.
    expect(
      fetchedUrls().filter((url) => url !== "/api/frames/firmware"),
    ).toHaveLength(0);
  });

  it("requires a frame name before touching the network", async () => {
    mockCloudApi();
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    fireEvent.change(await screen.findByLabelText("Frame hardware"), {
      target: { value: "panel:EPD_7in5_V2" },
    });
    clickFlash();

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/Name the frame/),
    );
    // Only the mount-time release probe may have fired.
    expect(
      fetchedUrls().filter((url) => url !== "/api/frames/firmware"),
    ).toHaveLength(0);
  });

  it("requires a hardware choice — there is no default board any more", async () => {
    // The old default ("XIAO + 7.5\" V2") was a combo nobody actually runs,
    // and silently provisioning any one bundle would misconfigure every
    // other board. The picker starts on a placeholder and flashing refuses
    // until something real is chosen.
    mockCloudApi();
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await screen.findByLabelText("Frame hardware");
    fireEvent.change(screen.getByLabelText("Frame name"), {
      target: { value: "Kitchen" },
    });
    clickFlash();

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/Pick the frame hardware/),
    );
    expect(esptool.calls.writeFlash).not.toHaveBeenCalled();
    expect(fetchedUrls()).not.toContain("/api/frames/claim-tokens");
  });

  it("flashes and provisions using only same-origin requests, quoting WiFi values", async () => {
    mockCloudApi();
    const port = createHealthyPort();
    stubSerial(port);
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await screen.findByRole("button", { name: /connect & flash/i });

    // The flasher owns its own name field (each enrollment path names its own
    // frame); the value must reach the claim-token mint.
    await fillRequiredFields();
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
      "/api/frames/firmware?platform=esp32-s3-generic",
    );
    expect(esptool.calls.writeFlash).toHaveBeenCalledOnce();
    expect(esptool.calls.disconnects).toBe(1);
    // esptool-js 0.6 takes a Uint8Array. A binary string reaches pako's
    // deflate(), which UTF-8-encodes it — the stub then decompresses more
    // bytes than declared and every attempt fails with status 201
    // (ESP_TOO_MUCH_DATA), writing corrupt data along the way.
    const flashOptions = esptool.calls.writeFlash.mock.calls[0]![0] as {
      compress: boolean;
      fileArray: { address: number; data: unknown }[];
    };
    expect(flashOptions.fileArray).toHaveLength(1);
    expect(flashOptions.fileArray[0]!.address).toBe(0);
    expect(flashOptions.fileArray[0]!.data).toBeInstanceOf(Uint8Array);
    expect(flashOptions.compress).toBe(true);

    // Spaces survive because the value is quoted; the embedded quote is escaped.
    expect(port.writes).toEqual([
      `set cloud_url "${window.location.origin}"`,
      'set claim_token "FRCT_minted"',
      'set panel "EPD_7in5_V2"',
      'wifi "My Home WiFi" "pa ss\\"word"',
    ]);
    // The claim token is minted once, and only after the flash succeeded.
    const mintCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/frames/claim-tokens",
    );
    expect(mintCalls).toHaveLength(1);
    // The name typed into the flasher's own field rides along with the mint.
    expect(JSON.parse(String(mintCalls[0]![1]?.body))).toEqual({
      name: "Kitchen",
    });
  });

  it("hands off to the enrolled frame once it appears in the account", async () => {
    // The fleet is snapshotted before the claim token is minted; whatever
    // frame appears beyond that set is the one this flash enrolled. The
    // first list call is the snapshot (empty), the next is the watcher's
    // poll after "done" — by then the board has enrolled.
    let framesCalls = 0;
    mockCloudApi(undefined, metadataPayload, () => {
      framesCalls += 1;
      return framesCalls === 1
        ? []
        : [
            {
              created_at: "2026-08-02T00:00:00Z",
              id: "abc-123",
              name: "Kitchen",
              status: "pending",
            },
          ];
    });
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await fillRequiredFields();
    clickFlash();

    const done = await screen.findByTestId("esp32-flash-done", undefined, {
      timeout: 5000,
    });
    const open = await screen.findByTestId("esp32-flash-open-frame", undefined, {
      timeout: 5000,
    });
    // cloudFrameUrl: SPA base path /frames + its own /frames/<id> route.
    expect(open.getAttribute("href")).toBe("/frames/abc-123");
    expect(done.textContent).toContain("Kitchen");
    expect(done.textContent).toContain("waiting for your confirmation");
  });

  it("keeps Done quiet when the fleet snapshot was unavailable", async () => {
    // No snapshot means no way to tell the new frame from the old ones —
    // the panel must not guess (and must not poll forever).
    mockCloudApi(undefined, metadataPayload, () => {
      throw new Error("frames list down");
    });
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await fillRequiredFields();
    clickFlash();

    const done = await screen.findByTestId("esp32-flash-done", undefined, {
      timeout: 5000,
    });
    expect(done.textContent).toBe("");
    expect(screen.queryByTestId("esp32-flash-open-frame")).toBeNull();
  });

  it("provisions the chosen e-paper panel when the release ships the all-panels firmware", async () => {
    mockCloudApi();
    const port = createHealthyPort();
    stubSerial(port);
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);

    await fillRequiredFields("panel:EPD_13in3e");
    clickFlash();
    await screen.findByTestId("esp32-flash-done", undefined, { timeout: 5000 });

    expect(port.writes).toEqual([
      `set cloud_url "${window.location.origin}"`,
      'set claim_token "FRCT_minted"',
      'set panel "EPD_13in3e"',
      "restart",
    ]);
  });

  it("remembers WiFi credentials in localStorage only when asked to", async () => {
    mockCloudApi();
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await fillRequiredFields();

    fireEvent.change(screen.getByLabelText("WiFi network"), {
      target: { value: "MyNet" },
    });
    fireEvent.change(screen.getByLabelText("WiFi password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByLabelText(/Remember WiFi credentials/));
    clickFlash();
    await screen.findByTestId("esp32-flash-done", undefined, { timeout: 5000 });

    // Shared with the SD image builder: one stored network for the panel.
    expect(localStorage.getItem("frameos-sd-image-wifi")).toBe(
      JSON.stringify({ password: "hunter2", ssid: "MyNet" }),
    );
    localStorage.removeItem("frameos-sd-image-wifi");
  });

  it("provisions a GPIO pin override after the hardware choice, so it wins", async () => {
    mockCloudApi();
    const port = createHealthyPort();
    stubSerial(port);
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);

    await fillRequiredFields("hw:waveshare_esp32_s3_photopainter");
    fireEvent.change(screen.getByLabelText("GPIO pins (optional)"), {
      target: { value: "rst=1,dc=2,cs=3,cs2=-1,busy=4,sck=5,mosi=6,pwr=-1" },
    });
    clickFlash();
    await screen.findByTestId("esp32-flash-done", undefined, { timeout: 5000 });

    const hardwareIndex = port.writes.findIndex((line) => line.startsWith("set hardware"));
    const pinsIndex = port.writes.indexOf('set pins "rst=1,dc=2,cs=3,cs2=-1,busy=4,sck=5,mosi=6,pwr=-1"');
    expect(hardwareIndex).toBeGreaterThanOrEqual(0);
    expect(pinsIndex).toBeGreaterThan(hardwareIndex);
  });

  it("refuses a malformed pin spec before touching the board", async () => {
    mockCloudApi();
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await screen.findByLabelText("Frame hardware");

    fireEvent.change(screen.getByLabelText("GPIO pins (optional)"), {
      target: { value: "rst=banana" },
    });
    clickFlash();

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/comma-separated key=number pairs/),
    );

    expect(pinsSpecError("")).toBeUndefined();
    expect(pinsSpecError("rst=5,cs2=-1")).toBeUndefined();
    expect(pinsSpecError("bogus=5")).toMatch(/Unknown pin/);
    expect(pinsSpecError("rst=99")).toMatch(/between -1/);
  });

  it("provisions integrated boards as hardware bundles, not bare panels", async () => {
    // A PhotoPainter needs its PMIC handling, EPD wiring, buttons and SD
    // pins — `set hardware` makes the firmware apply the whole bundle.
    mockCloudApi();
    const port = createHealthyPort();
    stubSerial(port);
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);

    await fillRequiredFields("hw:waveshare_esp32_s3_photopainter");
    clickFlash();
    await screen.findByTestId("esp32-flash-done", undefined, { timeout: 5000 });

    expect(port.writes).toContain('set hardware "waveshare_esp32_s3_photopainter"');
    expect(port.writes.some((line) => line.startsWith("set panel"))).toBe(false);
  });

  it("lists every ESP32-S3 hardware bundle and no ESP32-C3 boards", async () => {
    // Mirrors the S3 subset of EMBEDDED_HARDWARE_PRESETS in
    // backend/app/tasks/embedded_firmware.py (and the preset table in
    // fos_console.c) — a preset missing here cannot be provisioned from the
    // browser at all. The C3 boards (TRMNL OG/BWRY, XTEINK X4) are thin
    // clients with no cloud render source yet, so the cloud flasher must not
    // offer them until the cloud can render for them.
    mockCloudApi();
    stubSerial(createHealthyPort());
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);

    const picker = await screen.findByLabelText("Frame hardware");
    const values = Array.from(picker.querySelectorAll("option")).map(
      (option) => option.getAttribute("value"),
    );
    expect(values).toEqual(
      expect.arrayContaining([
        "hw:waveshare_esp32_s3_photopainter",
        "hw:waveshare_esp32_s3_epaper_13_3e6",
        "hw:trmnl_og_diy_kit",
        "hw:trmnl_4in26_diy_kit",
        "hw:seeed_reterminal_sticky",
        "hw:seeed_reterminal_e1001",
        "hw:seeed_reterminal_e1002",
        "hw:seeed_reterminal_e1004",
        "hw:elecrow_crowpanel_5in79",
      ]),
    );
    expect(values).not.toContain("hw:trmnl_og");
    expect(values).not.toContain("hw:trmnl_bwry");
    expect(values).not.toContain("hw:xteink_x4");
  });

  it("hides the panel picker for releases without the all-panels firmware", async () => {
    // Old single-panel firmware hard-fails display init on any other panel,
    // so offering a choice there would brick the render loop.
    mockCloudApi(undefined, legacyMetadataPayload);
    const port = createHealthyPort();
    stubSerial(port);
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await screen.findByRole("button", { name: /connect & flash/i });

    expect(screen.queryByLabelText("Frame hardware")).toBeNull();
    // Only the name is required here — there is no hardware picker to choose
    // from on a legacy release.
    fireEvent.change(screen.getByLabelText("Frame name"), {
      target: { value: "Kitchen" },
    });
    clickFlash();
    await screen.findByTestId("esp32-flash-done", undefined, { timeout: 5000 });
    expect(fetchedUrls()).toContain(
      "/api/frames/firmware?platform=esp32-s3-epd7in5v2",
    );
    expect(port.writes.some((line) => line.startsWith("set panel"))).toBe(false);
  });

  it("restarts the board when no WiFi is given, without waiting for output it never prints", async () => {
    mockCloudApi();
    const port = createHealthyPort();
    stubSerial(port);
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await fillRequiredFields();

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
    await fillRequiredFields();

    clickFlash();

    // A 502 from the firmware pipe means GitHub (the release host) is down —
    // the message says so instead of a bare status code.
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/GitHub seems to be having trouble.*HTTP 502/),
    );
    expect(fetchedUrls()).not.toContain("/api/frames/claim-tokens");
    expect(screen.queryByTestId("esp32-flash-done")).toBeNull();
  });

  it("flashes and provisions through a USB-UART bridge port", async () => {
    // Seeed's reTerminal E1001/E1002 expose only a CH340 ("USB Single
    // Serial", WCH vendor id) on UART0 — the chip's own USB-Serial/JTAG
    // port is not wired. The firmware console answers on UART0 as well, so
    // the bridge port must flash and provision like any other; refusing it
    // (as the flasher once did) left those boards with no way in at all.
    mockCloudApi();
    const port = createHealthyPort();
    (port as FakePort & { getInfo(): { usbVendorId: number } }).getInfo = () => ({
      usbVendorId: 0x1a86,
    });
    stubSerial(port);
    render(<Esp32CloudFlasher cloudOrigin={window.location.origin} />);
    await fillRequiredFields();

    clickFlash();

    await screen.findByTestId("esp32-flash-done", undefined, { timeout: 5000 });
    expect(esptool.calls.writeFlash).toHaveBeenCalled();
    expect(fetchedUrls()).toContain("/api/frames/claim-tokens");
    expect(port.writes.join("")).toContain("set claim_token");
    expect(screen.getByText(/WCH.*UART0 at 115200 baud/)).toBeTruthy();
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
    await fillRequiredFields();

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
    await fillRequiredFields();

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
    await fillRequiredFields();

    clickFlash();

    const alert = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alert).toHaveProperty(
      "textContent",
      expect.stringMatching(/flash write failed/),
    );
    // "It failed" is useless on its own — the causes are physical.
    expect(alert.textContent).toMatch(/USB cable/);
    // The port went back to the browser after every attempt, so a manual retry
    // can reopen it. Two attempts, both compressed: esptool-js 0.6 has no
    // uncompressed write path ("Yet to handle Non Compressed writes").
    expect(esptool.calls.disconnects).toBe(2);
    // Nothing enrolled: claim codes are single-use, so a failed flash must not
    // spend one.
    expect(fetchedUrls()).not.toContain("/api/frames/claim-tokens");
  });
});
