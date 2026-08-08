import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateFrameDevice } from "../../../../../src/lib/frame-device-auth";
import { devFirmwareOverride } from "../../../../../src/lib/firmware-release";
import { jsonError } from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { GET as getManifest } from "./manifest/route";
import { GET as getDownload } from "./download/route";

// Device-authed OTA routes (docs/cloud-frames.md "Signed OTA"). The bearer
// auth itself is integration-tested against a real enrollment in
// src/test/integration/frame-firmware.integration.test.ts; here it is mocked
// so the release-shape handling (missing .bin, missing .minisig, version
// prefix, streaming) can be pinned without a database, GitHub mocked like the
// sibling browser-flasher suite (../../firmware/route.test.ts).

vi.mock("../../../../../src/lib/rate-limit", () => ({
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../../src/lib/frame-device-auth", () => ({
  authenticateFrameDevice: vi.fn(),
}));
vi.mock("../../../../../src/lib/device-flow", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireDatabase: () => ({ db: {} as never, response: undefined }),
}));
// devFirmwareOverride reads a `.dev-firmware/` directory relative to the CWD
// (two levels up lands on the cloud workspace root, where anyone testing
// signed OTA against a locally built image keeps one). Left real, it wins over
// every mocked release below and rewrites this whole suite's expectations on
// whichever machine happens to have that directory. Overridable per test so
// the dev path itself can still be pinned.
vi.mock("../../../../../src/lib/firmware-release", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  devFirmwareOverride: vi.fn(() => Promise.resolve(undefined)),
}));

const authMock = vi.mocked(authenticateFrameDevice);
const devFirmwareMock = vi.mocked(devFirmwareOverride);
const rateLimitMock = vi.mocked(rateLimitResponse);
const fetchMock = vi.fn<typeof fetch>();

const frameId = "11111111-2222-3333-4444-555555555555";
const firmwareBytes = new Uint8Array(32).fill(0x5a);
const minisigText =
  "untrusted comment: signature from FrameOS firmware key\n" +
  "RWQfakeSignatureBase64\n" +
  "trusted comment: frameos frameos-1.2.3-esp32-s3-generic.bin\n" +
  "RWQfakeGlobalSignature\n";

// A real release publishes BOTH images per platform: the merged one the
// browser flasher writes at 0x0, and the bare app image OTA needs. These
// routes must pick the app image every time — see otaAssets in
// src/lib/firmware-release.ts.
const mergedBytes = new Uint8Array(64).fill(0xe9);
const releasePayload = {
  assets: [
    {
      browser_download_url:
        "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic.bin",
      name: "frameos-1.2.3-esp32-s3-generic.bin",
      size: mergedBytes.length,
    },
    {
      browser_download_url:
        "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic.bin.minisig",
      name: "frameos-1.2.3-esp32-s3-generic.bin.minisig",
      size: minisigText.length,
    },
    {
      browser_download_url:
        "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic-app.bin",
      name: "frameos-1.2.3-esp32-s3-generic-app.bin",
      size: firmwareBytes.length,
    },
    {
      browser_download_url:
        "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic-app.bin.minisig",
      name: "frameos-1.2.3-esp32-s3-generic-app.bin.minisig",
      size: minisigText.length,
    },
    {
      browser_download_url:
        "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-c3-generic-app.bin",
      name: "frameos-1.2.3-esp32-c3-generic-app.bin",
      size: 16,
    },
  ],
  tag_name: "v1.2.3",
};

function mockGitHub(release: unknown = releasePayload) {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      return Promise.resolve(Response.json(release));
    }
    if (url.startsWith("https://github.com/")) {
      if (url.endsWith(".minisig")) {
        return Promise.resolve(new Response(minisigText));
      }
      // Distinct bytes per artifact, so "served the wrong one" is visible.
      const body = url.endsWith("-app.bin") ? firmwareBytes : mergedBytes;
      return Promise.resolve(
        new Response(body.slice(), {
          headers: { "content-length": String(body.length) },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function request(path: string) {
  return new NextRequest(`https://cloud.example${path}`, {
    headers: { authorization: "Bearer fc_link_test" },
  });
}

const routeParams = (id: string) => ({ params: Promise.resolve({ frameId: id }) });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  authMock.mockResolvedValue({
    frame: { id: frameId } as never,
    linkedClient: { scopes: ["frame:managed"] } as never,
  });
});

afterEach(() => {
  fetchMock.mockReset();
  rateLimitMock.mockClear();
  authMock.mockReset();
  devFirmwareMock.mockReset();
  devFirmwareMock.mockResolvedValue(undefined);
  vi.unstubAllGlobals();
});

describe("GET /api/frames/[frameId]/firmware/manifest", () => {
  const manifest = (platform = "esp32-s3-generic", id = frameId) =>
    getManifest(
      request(`/api/frames/${id}/firmware/manifest?platform=${platform}`),
      routeParams(id),
    );

  it("serves the signed manifest: version without the v prefix, size, minisig text, downloadUrl", async () => {
    mockGitHub();

    const response = await manifest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      platform: "esp32-s3-generic",
      version: "1.2.3",
      size: firmwareBytes.length,
      minisig: minisigText,
      downloadUrl: `/api/frames/${frameId}/firmware/download?platform=esp32-s3-generic`,
    });
    expect(rateLimitMock.mock.calls[0]?.[1]).toBe("frames:device-firmware-meta");
  });

  it("relays the device auth failure before touching GitHub", async () => {
    authMock.mockResolvedValue({ response: jsonError("invalid_link_token", 401) });
    mockGitHub();

    const response = await manifest();

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a token whose frame is not the one in the path", async () => {
    mockGitHub();

    const response = await manifest(
      "esp32-s3-generic",
      "99999999-8888-7777-6666-555555555555",
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "frame_mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows only the ESP32 platform allow-list", async () => {
    mockGitHub();

    for (const platform of ["raspberry-pi-zero-2-w", "esp32-s3-evil", ""]) {
      const response = await manifest(platform);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_platform",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when the release has no such asset", async () => {
    mockGitHub({ assets: [], tag_name: "v1.2.3" });

    const response = await manifest();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "ota_image_not_published",
      platform: "esp32-s3-generic",
      release: "v1.2.3",
    });
  });

  it("404s a release that publishes only the merged flash image", async () => {
    // Every release up to and including v2026.8.12. Falling back to the
    // merged image here would hand the device several MB it can only reject:
    // esp_ota_end validates an esp_app_desc at 0x20, and a merged image has
    // the bootloader there.
    mockGitHub({
      assets: releasePayload.assets.filter(
        (asset) => !asset.name.includes("-app.bin"),
      ),
      tag_name: "v1.2.3",
    });

    const response = await manifest();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "ota_image_not_published",
      platform: "esp32-s3-generic",
      release: "v1.2.3",
    });
  });

  it("409s a release whose .bin carries no .minisig — never offer an unverifiable image", async () => {
    // esp32-c3-generic-app.bin exists in the fixture, its .minisig does not.
    mockGitHub();

    const response = await manifest("esp32-c3-generic");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "unsigned_release",
      platform: "esp32-c3-generic",
      release: "v1.2.3",
    });
  });

  it("502s when GitHub is down", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    const response = await manifest();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "release_lookup_failed",
    });
  });

  it("prefers a local .dev-firmware image over the release, without touching GitHub", async () => {
    mockGitHub();
    devFirmwareMock.mockResolvedValue({
      version: "9.9.9-dev",
      size: 4096,
      minisig: minisigText,
      filePath: "/tmp/esp32-s3-generic.bin",
    });

    const response = await manifest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      platform: "esp32-s3-generic",
      version: "9.9.9-dev",
      size: 4096,
      minisig: minisigText,
      downloadUrl: `/api/frames/${frameId}/firmware/download?platform=esp32-s3-generic`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/frames/[frameId]/firmware/download", () => {
  const download = (platform = "esp32-s3-generic", id = frameId) =>
    getDownload(
      request(`/api/frames/${id}/firmware/download?platform=${platform}`),
      routeParams(id),
    );

  it("streams the firmware through the host-pinned pipe with its name and release", async () => {
    mockGitHub();

    const response = await download();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("x-frameos-image-name")).toBe(
      "frameos-1.2.3-esp32-s3-generic-app.bin",
    );
    expect(response.headers.get("x-frameos-release")).toBe("v1.2.3");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(firmwareBytes);
    expect(rateLimitMock.mock.calls[0]?.[1]).toBe("frames:device-firmware");
  });

  it("refuses an asset URL that does not live on github.com", async () => {
    mockGitHub({
      assets: [
        {
          browser_download_url:
            "https://evil.example/frameos-1.2.3-esp32-s3-generic-app.bin",
          name: "frameos-1.2.3-esp32-s3-generic-app.bin",
          size: 32,
        },
        {
          browser_download_url:
            "https://evil.example/frameos-1.2.3-esp32-s3-generic-app.bin.minisig",
          name: "frameos-1.2.3-esp32-s3-generic-app.bin.minisig",
          size: 128,
        },
      ],
      tag_name: "v1.2.3",
    });

    const response = await download();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "release_lookup_failed",
    });
    // Only the API lookup happened; the untrusted host was never contacted.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("409s an unsigned release instead of serving bytes the device would reject", async () => {
    mockGitHub();

    const response = await download("esp32-c3-generic");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "unsigned_release",
      platform: "esp32-c3-generic",
      release: "v1.2.3",
    });
    // The release listing was consulted; the binary itself never fetched.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("guards the path/token match like the manifest", async () => {
    mockGitHub();

    const response = await download(
      "esp32-s3-generic",
      "99999999-8888-7777-6666-555555555555",
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "frame_mismatch" });
  });
});
