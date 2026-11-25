// @vitest-environment jsdom
//
// flash.frameos.net and the pages that hand it their USB work
// (frontend/src/utils/flasherBridge.ts, cloud/docs/flasher.md). What is
// pinned here is what keeps the bridge safe to have: a setup document is read
// as data and refused when it is anything else (a cloud enrollment, a console
// line with a line break in it), and the flasher hears only the window that
// opened it, at the origin its job came from.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeFirmwareSource,
  listenForBridgeJob,
  type BridgeConnection,
} from "../../../../../../cloud-frontend/src/flasher/bridgeClient";
import {
  DEFAULT_FLASHER_URL,
  FrameSetupError,
  bridgeMessage,
  flasherBridgeUrl,
  flasherOrigin,
  flasherUrl,
  frameSetupFileName,
  parseFrameSetupDocument,
  readFlasherMessage,
  readOpenerMessage,
} from "../../../../../../frontend/src/utils/flasherBridge";
import { overrideReleaseSigningKeyForTests } from "../../../../../../frontend/src/utils/releaseSigning";
import { testSigningKey } from "./fixtures/releaseSigning";

// What backend `GET /api/frames/{id}/embedded/setup` answers
// (backend/app/api/tests/test_embedded_setup.py pins that side).
function backendSetupDocument(overrides: Record<string, unknown> = {}) {
  return {
    format: "frameos-setup" as const,
    version: 1,
    createdAt: "2026-11-24T19:00:00Z",
    frame: { id: 12, name: "Kitchen" },
    backend: { url: "http://192.168.1.10:8989" },
    provisioning: {
      supported: true,
      platform: "esp32-s3",
      releasePlatform: "esp32-s3-32mb",
      releaseFlashSize: "32MB",
      releaseFormat: "bin" as const,
      blockers: [],
      warnings: ["This frame has no Wi-Fi network configured, so the board starts its setup portal instead of connecting."],
      settings: [
        { key: "hardware", value: "seeed_reterminal_e1002", secret: false },
        { key: "backend", value: "http://192.168.1.10:8989", secret: false },
        { key: "api_key", value: "key-12", secret: true },
        { key: "frame_id", value: "12", secret: false },
      ],
      wifi: { ssid: "Home", password: "hunter2" },
    },
    scenes: [{ id: "clock", name: "Clock", nodes: [], edges: [] }],
    ...overrides,
  };
}

function withSettings(settings: unknown[]) {
  const document = backendSetupDocument();
  return { ...document, provisioning: { ...document.provisioning, settings } };
}

afterEach(() => {
  delete (window as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG;
  overrideReleaseSigningKeyForTests(undefined);
});

describe("parseFrameSetupDocument", () => {
  it("reads the backend's setup document", () => {
    const setup = parseFrameSetupDocument(backendSetupDocument());
    expect(setup.frame).toEqual({ id: 12, name: "Kitchen" });
    expect(setup.provisioning.settings.map((setting) => setting.key)).toEqual([
      "hardware",
      "backend",
      "api_key",
      "frame_id",
    ]);
    expect(setup.provisioning.settings[2]).toEqual({ key: "api_key", value: "key-12", secret: true });
    expect(setup.provisioning.wifi).toEqual({ ssid: "Home", password: "hunter2" });
    expect(setup.provisioning.releasePlatform).toBe("esp32-s3-32mb");
    expect(setup.scenes).toHaveLength(1);
  });

  it("refuses what is not a setup file", () => {
    for (const value of [null, [], "frameos-setup", { format: "something-else" }, { ...backendSetupDocument(), frame: {} }]) {
      expect(() => parseFrameSetupDocument(value)).toThrow(FrameSetupError);
    }
    expect(() => parseFrameSetupDocument(backendSetupDocument({ version: 2 }))).toThrow(/newer FrameOS/);
  });

  it("never makes a board somebody's cloud frame", () => {
    for (const key of ["cloud_url", "claim_token", "cloud_wsurl"]) {
      expect(() => parseFrameSetupDocument(withSettings([{ key, value: "x", secret: false }]))).toThrow(
        /joins FrameOS Cloud from the cloud/
      );
    }
  });

  it("refuses a setting no console line could carry", () => {
    for (const setting of [
      { key: "panel", value: "EPD_7in5_V2\nfactory-reset", secret: false },
      { key: "Panel; reboot", value: "x", secret: false },
      { key: "panel", value: 7, secret: false },
    ]) {
      expect(() => parseFrameSetupDocument(withSettings([setting]))).toThrow(/could not take/);
    }
    const document = backendSetupDocument();
    expect(() =>
      parseFrameSetupDocument({
        ...document,
        provisioning: { ...document.provisioning, wifi: { ssid: "Home\nset api_key x", password: "" } },
      })
    ).toThrow(/Wi-Fi/);
  });

  it("names the file after the frame", () => {
    expect(frameSetupFileName("Kitchen frame #2")).toBe("kitchen-frame-2.frameos-setup.json");
    expect(frameSetupFileName("***")).toBe("frame.frameos-setup.json");
  });
});

describe("the bridge's messages", () => {
  it("reads only its own envelope", () => {
    expect(readFlasherMessage(bridgeMessage({ type: "ready" }))).toEqual(expect.objectContaining({ type: "ready" }));
    expect(readFlasherMessage({ type: "ready" })).toBeNull();
    expect(readFlasherMessage({ ...bridgeMessage({ type: "ready" }), version: 99 })).toBeNull();
    expect(readFlasherMessage(bridgeMessage({ type: "job" } as never))).toBeNull();
    // A platform goes into a URL path's query on the opener's side.
    expect(readFlasherMessage(bridgeMessage({ type: "image-request", id: 1, platform: "../settings" }))).toBeNull();
    expect(readFlasherMessage(bridgeMessage({ type: "flash-size", flashSize: "16MB" }))).not.toBeNull();
    expect(readFlasherMessage(bridgeMessage({ type: "flash-size", flashSize: "lots" }))).toBeNull();
    expect(readOpenerMessage(bridgeMessage({ type: "image", id: 1, name: "x", release: "v1", bytes: new ArrayBuffer(2), minisig: null }))).not.toBeNull();
    expect(readOpenerMessage(bridgeMessage({ type: "image", id: 1, bytes: "AAAA" } as never))).toBeNull();
  });

  it("opens flash.frameos.net unless the backend names another flasher", () => {
    expect(flasherUrl()).toBe(DEFAULT_FLASHER_URL);
    expect(flasherBridgeUrl()).toBe("https://flash.frameos.net/?bridge=1");
    (window as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG = { flasher_url: "https://flasher.example/x/" };
    expect(flasherUrl()).toBe("https://flasher.example/x");
    expect(flasherOrigin()).toBe("https://flasher.example");
    (window as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG = { flasher_url: "javascript:alert(1)" };
    expect(flasherUrl()).toBe(DEFAULT_FLASHER_URL);
  });
});

describe("listenForBridgeJob", () => {
  function fakeOpener() {
    const sent: { message: unknown; target: string }[] = [];
    const opener = {
      postMessage: (message: unknown, target: string) => sent.push({ message, target }),
    } as unknown as Window;
    Object.defineProperty(window, "opener", { configurable: true, value: opener });
    return { opener, sent };
  }

  function deliver(source: unknown, origin: string, data: unknown) {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
  }

  afterEach(() => {
    Object.defineProperty(window, "opener", { configurable: true, value: null });
  });

  it("says hello with nothing in it, then talks only to the origin the job came from", async () => {
    const { opener, sent } = fakeOpener();
    const jobs: BridgeConnection[] = [];
    const stop = listenForBridgeJob(
      (connection) => jobs.push(connection),
      () => undefined
    );
    expect(sent).toEqual([{ message: bridgeMessage({ type: "ready" }), target: "*" }]);

    // Another window's message, even a well-formed job, is not the opener's.
    deliver({}, "http://evil.example", bridgeMessage({ type: "job", job: { kind: "setup", setup: backendSetupDocument() } }));
    expect(jobs).toHaveLength(0);

    deliver(opener, "http://192.168.1.10:8989", bridgeMessage({ type: "job", job: { kind: "setup", setup: backendSetupDocument() } }));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.origin).toBe("http://192.168.1.10:8989");
    expect(jobs[0]!.job.setup.frame.name).toBe("Kitchen");

    // Requests go to that origin only, and an answer from elsewhere is ignored.
    const listing = jobs[0]!.listing();
    const request = sent.at(-1)!;
    expect(request.target).toBe("http://192.168.1.10:8989");
    const id = (request.message as { id: number }).id;
    deliver(opener, "http://evil.example", bridgeMessage({ type: "listing", id, listing: { release: "vX", assets: [] } }));
    deliver(opener, "http://192.168.1.10:8989", bridgeMessage({ type: "listing", id, listing: { release: "v1.2.3", assets: [] } }));
    await expect(listing).resolves.toEqual({ release: "v1.2.3", assets: [] });
    stop();
  });

  it("refuses a job that is not a setup document", () => {
    const { opener } = fakeOpener();
    const problems: string[] = [];
    const stop = listenForBridgeJob(
      () => undefined,
      (problem) => problems.push(problem)
    );
    deliver(
      opener,
      "http://192.168.1.10:8989",
      bridgeMessage({ type: "job", job: { kind: "setup", setup: withSettings([{ key: "claim_token", value: "x" }]) } })
    );
    expect(problems.join(" ")).toMatch(/cloud/);
    stop();
  });

  it("says so when nothing opened the window", () => {
    Object.defineProperty(window, "opener", { configurable: true, value: null });
    const problems: string[] = [];
    listenForBridgeJob(
      () => undefined,
      (problem) => problems.push(problem)
    );
    expect(problems[0]).toMatch(/not opened by a FrameOS backend/);
  });
});

describe("bridgeFirmwareSource", () => {
  const listing = {
    release: "v2026.11.14",
    assets: [{ name: "frameos-2026.11.14-esp32-s3-generic.bin", platform: "esp32-s3-generic", size: 4 }],
  };
  const bytes = new Uint8Array([1, 2, 3, 4]);

  function connection(minisig: string | null, answerBytes = bytes): BridgeConnection {
    return {
      origin: "http://192.168.1.10:8989",
      job: { kind: "setup", setup: parseFrameSetupDocument(backendSetupDocument()) },
      listing: async () => listing,
      image: async () => ({
        type: "image",
        id: 1,
        name: listing.assets[0]!.name,
        release: listing.release,
        bytes: answerBytes.slice().buffer,
        minisig,
      }),
      send: () => undefined,
      status: () => undefined,
    };
  }

  it("writes a page's image only when the release signature says it is this release's", async () => {
    const key = testSigningKey();
    overrideReleaseSigningKeyForTests(key.publicKeyBase64);
    const log = vi.fn();

    const signed = key.minisigFor(bytes, { signedAs: "frameos-2026.11.14-esp32-s3-generic.bin" });
    const image = await bridgeFirmwareSource(connection(signed)).image("esp32-s3-generic", listing, log);
    expect(image.signed).toBe(true);
    expect(Array.from(image.bytes)).toEqual([1, 2, 3, 4]);

    // Other bytes, another release's signature, no signature: never written.
    await expect(
      bridgeFirmwareSource(connection(signed, new Uint8Array([9, 9, 9, 9]))).image("esp32-s3-generic", listing, log)
    ).rejects.toThrow(/does not match/);
    const older = key.minisigFor(bytes, { signedAs: "frameos-2026.11.1-esp32-s3-generic.bin" });
    await expect(bridgeFirmwareSource(connection(older)).image("esp32-s3-generic", listing, log)).rejects.toThrow(
      /signature is for/
    );
    await expect(bridgeFirmwareSource(connection(null)).image("esp32-s3-generic", listing, log)).rejects.toThrow(
      /only writes signed FrameOS releases/
    );
  });
});

describe("httpFirmwareSource", () => {
  it("checks the bytes as the release that served them, and never writes an unsigned release image", async () => {
    const { httpFirmwareSource } = await import("../../../../../../frontend/src/scenes/workspace/releaseFirmware");
    const key = testSigningKey();
    overrideReleaseSigningKeyForTests(key.publicKeyBase64);
    const bytes = new Uint8Array([5, 6, 7]);
    // The listing was read just before a new release; the bytes are the new one's.
    const listing = {
      release: "v2026.11.14",
      assets: [{ name: "frameos-2026.11.14-esp32-s3-generic.bin", platform: "esp32-s3-generic", size: 3 }],
    };
    const fetcher = (signedAs: string | null, servedRelease = "v2026.11.15") =>
      vi.fn(async (url: string) => {
        if (url.endsWith("&signature=1")) {
          return signedAs ? new Response(key.minisigFor(bytes, { signedAs })) : Response.json({}, { status: 409 });
        }
        return new Response(bytes.slice(), { headers: { "x-frameos-release": servedRelease } });
      });

    const newer = httpFirmwareSource(fetcher("frameos-2026.11.15-esp32-s3-generic.bin"), { requireSignature: true });
    await expect(newer.image("esp32-s3-generic", listing, () => undefined)).resolves.toMatchObject({
      release: "v2026.11.15",
      signed: true,
    });

    // A release image with no signature is refused even by a plane's own
    // flasher; only its local-dev build is written unverified, and never by
    // flash.frameos.net.
    const unsigned = httpFirmwareSource(fetcher(null), { requireSignature: false });
    await expect(unsigned.image("esp32-s3-generic", listing, () => undefined)).rejects.toThrow(/could not be fetched/);
    const localDev = httpFirmwareSource(fetcher(null, "local-dev"), { requireSignature: false });
    await expect(localDev.image("esp32-s3-generic", listing, () => undefined)).resolves.toMatchObject({ signed: false });
    const localDevOnFlasher = httpFirmwareSource(fetcher(null, "local-dev"), { requireSignature: true });
    await expect(localDevOnFlasher.image("esp32-s3-generic", listing, () => undefined)).rejects.toThrow(
      /could not be fetched/
    );
  });
});
