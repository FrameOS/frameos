import { NextRequest } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetReleaseCacheForTests } from "../../../../src/lib/firmware-release";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { GET } from "./route";

vi.mock("../../../../src/lib/rate-limit", () => ({
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));

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
        "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-raspberry-pi-64-buildroot.img.gz",
      name: "frameos-1.2.3-raspberry-pi-64-buildroot.img.gz",
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
  resetReleaseCacheForTests();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  rateLimitMock.mockClear();
  vi.unstubAllGlobals();
});

describe("GET /api/frames/firmware", () => {
  it("answers without a session, within the per-address budget", async () => {
    // flash.frameos.net flashes from here for people with no account, and its
    // host serves every request as to a stranger (cloud/docs/flasher.md).
    mockGitHub();
    rateLimitMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ error: "rate_limited" }, { status: 429 }) as never),
    );

    const limited = await GET(request("?platform=esp32-s3-epd7in5v2"));
    expect(limited.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();

    const response = await GET(request("?platform=esp32-s3-epd7in5v2"));
    expect(response.status).toBe(200);
  });

  it("hands out the image's signature, named, for the browser to check", async () => {
    const minisig = "untrusted comment: x\nRWQ...\ntrusted comment: frameos frameos-1.2.3-esp32-s3-generic.bin\nabc\n";
    const signed = {
      assets: [
        {
          browser_download_url:
            "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic.bin",
          name: "frameos-1.2.3-esp32-s3-generic.bin",
          size: firmwareBytes.length,
        },
        // The OTA image's signature is another file and must not answer.
        {
          browser_download_url:
            "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic-app.bin.minisig",
          name: "frameos-1.2.3-esp32-s3-generic-app.bin.minisig",
          size: 300,
        },
        {
          browser_download_url:
            "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic.bin.minisig",
          name: "frameos-1.2.3-esp32-s3-generic.bin.minisig",
          size: minisig.length,
        },
      ],
      tag_name: "v1.2.3",
    };
    const fetched: string[] = [];
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      fetched.push(url);
      if (url.startsWith("https://api.github.com/")) {
        return Promise.resolve(Response.json(signed));
      }
      return Promise.resolve(new Response(minisig));
    });

    const response = await GET(request("?platform=esp32-s3-generic&signature=1"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(minisig);
    expect(response.headers.get("x-frameos-image-name")).toBe("frameos-1.2.3-esp32-s3-generic.bin");
    expect(response.headers.get("x-frameos-release")).toBe("v1.2.3");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetched.filter((url) => url.startsWith("https://github.com/"))).toEqual([
      "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic.bin.minisig",
    ]);
  });

  it("says when an image has no signature", async () => {
    mockGitHub();

    const unsigned = await GET(request("?platform=esp32-s3-epd7in5v2&signature=1"));
    expect(unsigned.status).toBe(409);
    await expect(unsigned.json()).resolves.toMatchObject({ error: "unsigned_release" });

    const missing = await GET(request("?platform=esp32-s3-16mb&signature=1"));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "firmware_not_published" });
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
          name: "frameos-1.2.3-raspberry-pi-64-buildroot.img.gz",
          platform: "raspberry-pi-64",
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

    const response = await GET(request("?platform=raspberry-pi-64"));

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

  it("never calls the local build signed", async () => {
    mockGitHub();
    const response = await GET(request("?platform=esp32-s3-generic&signature=1"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "unsigned_release" });
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
