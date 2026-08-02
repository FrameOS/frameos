import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";
import { GET } from "./route";

vi.mock("../../../../src/lib/rate-limit", () => ({
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../src/lib/session", () => ({
  readSession: vi.fn(() => Promise.resolve({ accountId: "acct_1" })),
}));

const readSessionMock = vi.mocked(readSession);
const rateLimitMock = vi.mocked(rateLimitResponse);
const fetchMock = vi.fn<typeof fetch>();

const firmwareBytes = new Uint8Array(32).fill(0x5a);
const releasePayload = {
  assets: [
    {
      browser_download_url:
        "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-epd7in5v2.bin",
      name: "frameos-1.2.3-esp32-s3-epd7in5v2.bin",
      size: firmwareBytes.length,
    },
    {
      browser_download_url:
        "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-raspberry-pi-zero-2-w-buildroot.img.gz",
      name: "frameos-1.2.3-raspberry-pi-zero-2-w-buildroot.img.gz",
      size: 4096,
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
      return Promise.resolve(
        new Response(firmwareBytes.slice(), {
          headers: { "content-length": String(firmwareBytes.length) },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function request(query = "") {
  return new NextRequest(`https://cloud.example/api/frames/firmware${query}`);
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  rateLimitMock.mockClear();
  readSessionMock.mockClear();
  readSessionMock.mockImplementation(() =>
    Promise.resolve({ accountId: "acct_1" } as never),
  );
  vi.unstubAllGlobals();
});

describe("GET /api/frames/firmware", () => {
  it("requires a session before reaching GitHub", async () => {
    mockGitHub();
    readSessionMock.mockImplementation(() => Promise.resolve(undefined));

    const response = await GET(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "login_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists every provisioning artifact, ESP32 and SD alike", async () => {
    mockGitHub();

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      assets: [
        {
          name: "frameos-1.2.3-esp32-s3-epd7in5v2.bin",
          platform: "esp32-s3-epd7in5v2",
          size: firmwareBytes.length,
        },
        {
          name: "frameos-1.2.3-raspberry-pi-zero-2-w-buildroot.img.gz",
          platform: "raspberry-pi-zero-2-w",
          size: 4096,
        },
      ],
      release: "v1.2.3",
    });
    // The listing gets the generous budget; the binary a tight one.
    expect(rateLimitMock.mock.calls[0]?.[1]).toBe("frames:firmware-meta");
  });

  it("streams the ESP32 firmware with its name and release", async () => {
    mockGitHub();

    const response = await GET(request("?platform=esp32-s3-epd7in5v2"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("x-frameos-image-name")).toBe(
      "frameos-1.2.3-esp32-s3-epd7in5v2.bin",
    );
    expect(response.headers.get("x-frameos-release")).toBe("v1.2.3");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(firmwareBytes);
    expect(rateLimitMock.mock.calls[0]?.[1]).toBe("frames:firmware");
  });

  it("refuses to stream anything but the ESP32 firmware", async () => {
    mockGitHub();

    const response = await GET(request("?platform=raspberry-pi-zero-2-w"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_platform",
    });
    // Not even the release lookup ran.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a release without the firmware instead of 500ing", async () => {
    mockGitHub({ assets: [], tag_name: "v1.2.3" });

    const response = await GET(request("?platform=esp32-s3-epd7in5v2"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "firmware_not_published",
      platform: "esp32-s3-epd7in5v2",
      release: "v1.2.3",
    });
  });

  it("refuses an asset URL that does not live on github.com", async () => {
    mockGitHub({
      assets: [
        {
          browser_download_url:
            "https://evil.example/frameos-1.2.3-esp32-s3-epd7in5v2.bin",
          name: "frameos-1.2.3-esp32-s3-epd7in5v2.bin",
          size: 32,
        },
      ],
      tag_name: "v1.2.3",
    });

    const response = await GET(request("?platform=esp32-s3-epd7in5v2"));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "release_lookup_failed",
    });
    // Only the API lookup happened; the untrusted host was never contacted.
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("local generic firmware escape hatch", () => {
  // Until a release publishes the all-panels build, a dev/self-hosted
  // deployment can serve a locally built binary via
  // FRAMEOS_ESP32_GENERIC_FIRMWARE — a published release always wins.
  const { mkdtempSync, rmSync, writeFileSync } = require("node:fs") as
    typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const localBytes = new Uint8Array(48).fill(0xab);
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "frameos-fw-"));
    writeFileSync(join(dir, "merged-binary.bin"), localBytes);
    process.env.FRAMEOS_ESP32_GENERIC_FIRMWARE = join(dir, "merged-binary.bin");
  });

  afterEach(() => {
    delete process.env.FRAMEOS_ESP32_GENERIC_FIRMWARE;
    rmSync(dir, { force: true, recursive: true });
  });

  it("advertises and serves the local build when the release has no generic asset", async () => {
    mockGitHub();
    const listing = (await (await GET(request())).json()) as {
      assets: { name: string; platform: string; size: number }[];
    };
    expect(listing.assets).toContainEqual({
      name: "merged-binary.bin",
      platform: "esp32-s3-generic",
      size: localBytes.length,
    });

    mockGitHub();
    const response = await GET(request("?platform=esp32-s3-generic"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frameos-release")).toBe("local-dev");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(localBytes);
  });

  it("prefers the release's generic asset over the local file", async () => {
    mockGitHub({
      assets: [
        {
          browser_download_url:
            "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic.bin",
          name: "frameos-1.2.3-esp32-s3-generic.bin",
          size: firmwareBytes.length,
        },
      ],
      tag_name: "v1.2.3",
    });
    const listing = (await (await GET(request())).json()) as {
      assets: { name: string }[];
    };
    expect(listing.assets.map((asset) => asset.name)).toContain(
      "frameos-1.2.3-esp32-s3-generic.bin",
    );
    expect(listing.assets.map((asset) => asset.name)).not.toContain(
      "merged-binary.bin",
    );
  });
});
