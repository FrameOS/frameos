// GitHub-release lookup and firmware streaming, shared by the session-gated
// browser flasher route (app/api/frames/firmware) and the device-authed OTA
// routes (app/api/frames/[frameId]/firmware/{manifest,download}).
//
// Nothing that talks to GitHub may run in the browser or on the device
// directly: the 302 from github.com carries no CORS headers and
// unauthenticated api.github.com is 60 requests/hour per IP (one corporate
// NAT is enough to 403 every user behind it), so both the listing and the
// bytes flow through these helpers, and the download is a straight pipe —
// the firmware is never buffered here.

import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { jsonError } from "./device-flow";

export const releaseApiUrl =
  "https://api.github.com/repos/FrameOS/frameos/releases/latest";

// Explicit allow-list of platform -> exact asset suffix. The upstream host and
// path are never taken from user input, so this cannot be steered into an SSRF.
// esp32-s3-generic carries every supported panel driver and selects one at
// runtime (`set panel` over serial / NVS); esp32-s3-epd7in5v2 is the older
// single-panel build kept so deployments running this code against an old
// release still flash something. Keep in sync with the esp32 job in
// .github/workflows/docker-publish-multi.yml.
export const provisioningAssets = [
  { platform: "esp32-s3-generic", suffix: "-esp32-s3-generic.bin" },
  { platform: "esp32-s3-epd7in5v2", suffix: "-esp32-s3-epd7in5v2.bin" },
  // Thin-client build for PSRAM-less ESP32-C3 boards (TRMNL OG/BWRY,
  // XTEINK X4): all panel drivers, no on-device renderer.
  { platform: "esp32-c3-generic", suffix: "-esp32-c3-generic.bin" },
  {
    platform: "raspberry-pi-zero-2-w",
    suffix: "-raspberry-pi-zero-2-w-buildroot.img.gz",
  },
  {
    platform: "raspberry-pi-zero-w",
    suffix: "-raspberry-pi-zero-w-buildroot.img.gz",
  },
] as const;

// Only the ESP32 firmware (a few MB) is ever streamed from here; the
// gigabyte-sized SD images go through app/api/frames/sd-image with its own
// much tighter budget.
export const streamablePlatforms = new Set<string>([
  "esp32-s3-generic",
  "esp32-s3-epd7in5v2",
  "esp32-c3-generic",
]);

export interface ReleaseAsset {
  browser_download_url: string;
  name: string;
  size: number;
}

export interface Release {
  assets?: ReleaseAsset[];
  tag_name?: string;
}

export function findAsset(release: Release, suffix: string) {
  return release.assets?.find(
    (entry) => entry.name.startsWith("frameos-") && entry.name.endsWith(suffix),
  );
}

/** The latest release's metadata, or undefined when GitHub says no. */
export async function fetchLatestRelease(): Promise<Release | undefined> {
  const response = await fetch(releaseApiUrl, {
    headers: { accept: "application/vnd.github+json" },
    // Releases change rarely; caching keeps us far from GitHub's rate limit.
    next: { revalidate: 300 },
  });
  if (!response.ok) {
    return undefined;
  }
  return (await response.json()) as Release;
}

// Belt and braces: asset URLs come from the GitHub API, but pin the host
// anyway so a compromised/unexpected API response cannot redirect us.
function pinnedAssetUrl(asset: ReleaseAsset): URL | undefined {
  let assetUrl: URL;
  try {
    assetUrl = new URL(asset.browser_download_url);
  } catch {
    return undefined;
  }
  if (assetUrl.protocol !== "https:" || assetUrl.host !== "github.com") {
    return undefined;
  }
  return assetUrl;
}

/**
 * Pipe one release asset straight through — the bytes are never buffered.
 * Returns the streaming 200 or the appropriate jsonError response.
 */
export async function streamReleaseAssetResponse(
  asset: ReleaseAsset,
  releaseTag: string,
): Promise<NextResponse> {
  const assetUrl = pinnedAssetUrl(asset);
  if (!assetUrl) {
    return jsonError("release_lookup_failed", 502);
  }

  const upstream = await fetch(assetUrl, { redirect: "follow" });
  if (!upstream.ok || !upstream.body) {
    return jsonError("firmware_download_failed", 502);
  }

  const headers = new Headers({
    "cache-control": "private, max-age=300",
    "content-type": "application/octet-stream",
    "x-frameos-image-name": asset.name,
    "x-frameos-release": releaseTag,
  });
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) {
    headers.set("content-length", contentLength);
  }
  return new NextResponse(upstream.body, { headers, status: 200 });
}

// A minisign signature file is a comment line plus two short base64 lines —
// a few hundred bytes. Anything bigger than this is not a signature.
export const maxSignatureAssetBytes = 4096;

/**
 * The full text of a small release asset (the .minisig files), or undefined
 * when it is oversized, off-host or unfetchable.
 */
export async function fetchReleaseAssetText(
  asset: ReleaseAsset,
): Promise<string | undefined> {
  if (asset.size > maxSignatureAssetBytes) {
    return undefined;
  }
  const assetUrl = pinnedAssetUrl(asset);
  if (!assetUrl) {
    return undefined;
  }
  const upstream = await fetch(assetUrl, {
    redirect: "follow",
    // Signatures are immutable per release and tiny; cache like the listing.
    next: { revalidate: 300 },
  });
  if (!upstream.ok) {
    return undefined;
  }
  const text = await upstream.text();
  // asset.size came from the API listing; re-check the bytes we actually got.
  if (Buffer.byteLength(text, "utf8") > maxSignatureAssetBytes) {
    return undefined;
  }
  return text;
}

// ---------------------------------------------------------------- dev mode
// Local firmware for OTA testing without a GitHub release: drop
// `<platform>.bin`, `<platform>.bin.minisig` and `version.txt` into a
// `.dev-firmware/` directory (next to the auth-web app, or two levels up at
// the cloud workspace root). Disabled in production builds.

export interface DevFirmware {
  version: string;
  size: number;
  minisig: string;
  filePath: string;
}

export async function devFirmwareOverride(
  platform: string,
): Promise<DevFirmware | undefined> {
  if (process.env.NODE_ENV === "production") {
    return undefined;
  }
  const candidates = [
    path.join(process.cwd(), ".dev-firmware"),
    path.join(process.cwd(), "..", "..", ".dev-firmware"),
  ];
  for (const dir of candidates) {
    try {
      const filePath = path.join(dir, `${platform}.bin`);
      const stat = await fs.stat(filePath);
      const minisig = await fs.readFile(`${filePath}.minisig`, "utf8");
      const version = (
        await fs.readFile(path.join(dir, "version.txt"), "utf8")
      ).trim();
      if (!version || stat.size === 0) {
        continue;
      }
      return { version, size: stat.size, minisig, filePath };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Stream a dev-override firmware file (dev builds only). */
export async function streamDevFirmwareResponse(
  dev: DevFirmware,
): Promise<NextResponse> {
  const data = await fs.readFile(dev.filePath);
  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(data.byteLength),
      "cache-control": "no-store",
    },
  });
}
