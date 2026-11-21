import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetReleaseCacheForTests } from "../../../src/lib/firmware-release";
import { rateLimitResponse } from "../../../src/lib/rate-limit";
import { resetUpdateManifestCacheForTests } from "../../../src/lib/update-manifest";
import { GET as getFirmwareDownload } from "./firmware/download/route";
import { GET as getFirmware } from "./firmware/route";
import { GET as getManifest } from "./manifest/route";
import { GET as getNext } from "./next/route";

// The public update routes (docs/auto-updates.md): the manifest mirror, the
// decision service, and the OTA manifest + image for an ESP32 with no plane.
// GitHub (the API, raw.githubusercontent and the release assets) is mocked.

vi.mock("../../../src/lib/rate-limit", () => ({
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));

const rateLimitMock = vi.mocked(rateLimitResponse);
const fetchMock = vi.fn<typeof fetch>();
const full = [{ afterHours: 0, percent: 100 }];
const manifest = {
  version: 1,
  defaultRollout: full,
  releases: [
    { version: "2026.11.13", at: "2026-11-20T00:00:00Z" },
    { version: "2026.11.14", at: "2026-11-21T00:00:00Z", blockedTargets: { "esp32/esp32-c3-*": "C3 boot loop" } },
  ],
};
const minisig = "untrusted comment: x\nRWQsig\ntrusted comment: frameos frameos-v-esp32-s3-generic-app.bin\nRWQglobal\n";
const image = Uint8Array.from({ length: 16 }, (_, i) => i);

function release(version: string) {
  const asset = (name: string, size: number) => ({
    browser_download_url: `https://github.com/FrameOS/frameos/releases/download/v${version}/${name}`,
    name,
    size,
  });
  return {
    tag_name: `v${version}`,
    assets: [
      asset(`frameos-${version}-esp32-s3-generic-app.bin`, image.length),
      asset(`frameos-${version}-esp32-s3-generic-app.bin.minisig`, minisig.length),
      asset(`frameos-${version}-esp32-c3-generic-app.bin`, image.length),
      asset(`frameos-${version}-esp32-c3-generic-app.bin.minisig`, minisig.length),
    ],
  };
}

function mockGitHub(body: unknown = manifest) {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      return Promise.resolve(body === null ? new Response("", { status: 404 }) : Response.json(body));
    }
    const tag = /\/releases\/tags\/v([\d.]+)$/.exec(url);
    if (tag) {
      return Promise.resolve(Response.json(release(tag[1]!)));
    }
    if (url.endsWith("/releases/latest")) {
      return Promise.resolve(Response.json(release("2026.11.14")));
    }
    if (url.endsWith(".minisig")) {
      return Promise.resolve(new Response(minisig));
    }
    if (url.startsWith("https://github.com/")) {
      return Promise.resolve(new Response(image.slice(), { headers: { "content-length": String(image.length) } }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

const get = (path: string) => new NextRequest(`https://cloud.example${path}`);

beforeEach(() => {
  resetReleaseCacheForTests();
  resetUpdateManifestCacheForTests();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  rateLimitMock.mockClear();
  vi.unstubAllGlobals();
});

describe("GET /api/updates/manifest", () => {
  it("mirrors the manifest", async () => {
    mockGitHub();
    const response = await getManifest(get("/api/updates/manifest"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(manifest);
    expect(rateLimitMock.mock.calls[0]?.[1]).toBe("updates:manifest");
  });

  it("502s with no copy at all", async () => {
    mockGitHub(null);
    const response = await getManifest(get("/api/updates/manifest"));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "manifest_unavailable" });
  });
});

describe("GET /api/updates/next", () => {
  it("answers the decision", async () => {
    mockGitHub();
    const response = await getNext(
      get("/api/updates/next?platform=esp32&target=esp32-c3-generic&version=2026.11.12&key=esp32:abc"),
    );
    expect(await response.json()).toMatchObject({
      version: "2026.11.13",
      reason: "held_back",
      latest: "2026.11.14",
      held: { version: "2026.11.14", why: "blocked" },
    });
  });

  it("refuses an unknown platform", async () => {
    mockGitHub();
    expect((await getNext(get("/api/updates/next?platform=windows&version=1.2.3"))).status).toBe(400);
  });
});

describe("GET /api/updates/firmware (a board with no plane)", () => {
  it("offers the decided release in the firmware's manifest shape, downloaded from this origin", async () => {
    mockGitHub();
    const response = await getFirmware(
      get("/api/updates/firmware?platform=esp32-s3-generic&version=2026.11.13&key=esp32:abc"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      platform: "esp32-s3-generic",
      version: "2026.11.14",
      size: image.length,
      minisig,
      downloadUrl: "/api/updates/firmware/download?platform=esp32-s3-generic&version=2026.11.14",
      reason: "latest",
      latest: "2026.11.14",
      held: null,
    });
  });

  it("an older release by its tag when the latest is blocked for the board", async () => {
    mockGitHub();
    const body = await (
      await getFirmware(get("/api/updates/firmware?platform=esp32-c3-generic&version=2026.11.12&key=esp32:abc"))
    ).json();
    expect(body).toMatchObject({ version: "2026.11.13", reason: "held_back" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/releases/tags/v2026.11.13"))).toBe(true);
  });

  it("the board's own version when there is nothing to install", async () => {
    mockGitHub();
    const body = await (
      await getFirmware(get("/api/updates/firmware?platform=esp32-c3-generic&version=2026.11.13&key=esp32:abc"))
    ).json();
    expect(body).toMatchObject({ version: "2026.11.13", size: 1, minisig: "", downloadUrl: "", reason: "held" });
  });

  it("no manifest: nothing for the board's own check, the latest for its console's `ota`", async () => {
    mockGitHub(null);
    const auto = await (
      await getFirmware(get("/api/updates/firmware?platform=esp32-s3-generic&version=2026.11.13&key=k"))
    ).json();
    expect(auto).toMatchObject({ version: "2026.11.13", reason: "no_manifest" });
    resetUpdateManifestCacheForTests();
    const manual = await (
      await getFirmware(get("/api/updates/firmware?platform=esp32-s3-generic&version=2026.11.13&key=k&manual=1"))
    ).json();
    expect(manual).toMatchObject({ version: "2026.11.14" });
  });

  it("only the OTA layouts", async () => {
    mockGitHub();
    for (const platform of ["raspberry-pi-64", "esp32-s3-epd7in5v2", ""]) {
      expect((await getFirmware(get(`/api/updates/firmware?platform=${platform}&version=1.2.3`))).status).toBe(400);
    }
  });
});

describe("GET /api/updates/firmware/download", () => {
  it("streams the named release's app image", async () => {
    mockGitHub();
    const response = await getFirmwareDownload(
      get("/api/updates/firmware/download?platform=esp32-s3-generic&version=2026.11.13"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frameos-release")).toBe("v2026.11.13");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
  });

  it("refuses a missing version or a platform outside the OTA layouts", async () => {
    mockGitHub();
    expect((await getFirmwareDownload(get("/api/updates/firmware/download?platform=esp32-s3-generic"))).status).toBe(400);
    expect(
      (await getFirmwareDownload(get("/api/updates/firmware/download?platform=pico-w&version=2026.11.13"))).status,
    ).toBe(400);
  });
});
