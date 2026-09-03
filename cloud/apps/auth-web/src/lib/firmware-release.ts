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

// One signed image per chip × flash layout (embedded/esp32/ci_build_image.sh,
// the esp32 jobs in .github/workflows/docker-publish-multi.yml). The generic
// pair IS the 8 MB S3 / 4 MB C3 layout; the others carry the layout in the
// name. Every image carries every panel driver and selects one at runtime
// (`set panel` over serial / NVS). The self-hosted backend keeps the same
// table in EMBEDDED_FLASH_PROFILES (backend/app/tasks/embedded_firmware.py),
// and a device names its own entry when it asks for an OTA manifest
// (fos_ota_platform in embedded/esp32/main/fos_ota.c).
export const esp32ReleasePlatforms = [
  "esp32-s3-generic",
  "esp32-c3-generic",
  "esp32-s3-4mb",
  "esp32-s3-16mb",
  "esp32-s3-32mb",
  "esp32-c3-8mb",
  "esp32-c3-16mb",
  "esp32-c3-32mb",
] as const;

// Explicit allow-list of platform -> exact asset suffix. The upstream host and
// path are never taken from user input, so this cannot be steered into an SSRF.
// esp32-s3-epd7in5v2 is the older single-panel build kept so deployments
// running this code against an old release still flash something.
export const provisioningAssets = [
  ...esp32ReleasePlatforms.map((platform) => ({ platform, suffix: `-${platform}.bin` })),
  { platform: "esp32-s3-epd7in5v2", suffix: "-esp32-s3-epd7in5v2.bin" },
  {
    platform: "raspberry-pi-32",
    suffix: "-raspberry-pi-32-buildroot.img.gz",
  },
  {
    platform: "raspberry-pi-64",
    suffix: "-raspberry-pi-64-buildroot.img.gz",
  },
  {
    platform: "raspberry-pi-5",
    suffix: "-raspberry-pi-5-buildroot.img.gz",
  },
] as const;

// OTA images. NOT the same file as above, and the difference is the whole
// reason this list exists: `provisioningAssets` points at the MERGED image
// (`idf.py merge-bin` — bootloader at 0x0, partition table, blank otadata,
// app at 0x10000), which is what a flasher writes to a blank board. An OTA
// slot takes only the bare app image: esp_ota_write/esp_ota_end validate an
// esp_app_desc at offset 0x20, and the merged image has the BOOTLOADER there,
// so a device offered one downloads several MB and then rejects it at the last
// step — every time, on every release. The release publishes both; the
// device-authed manifest/download routes serve this one, for the flash layout
// the device names (a 4 MB layout has no OTA slot; its image is published and
// served only for completeness).
//
// Releases from before the `-app.bin` assets shipped have no OTA image at all;
// those answer 404 ota_image_not_published rather than falling back to the
// merged image, which could only ever fail on the device.
export const otaAssets = esp32ReleasePlatforms.map((platform) => ({
  platform,
  suffix: `-${platform}-app.bin`,
}));

/** The bare app image for a platform, or undefined on an older release. */
export function findOtaAsset(release: Release, platform: string) {
  const entry = otaAssets.find((candidate) => candidate.platform === platform);
  return entry ? findAsset(release, entry.suffix) : undefined;
}

// Only the ESP32 firmware (a few MB) is ever streamed from here; the
// gigabyte-sized SD images go through app/api/frames/sd-image with its own
// much tighter budget.
export const streamablePlatforms = new Set<string>([
  ...esp32ReleasePlatforms,
  "esp32-s3-epd7in5v2",
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

// In-process release cache. Every browser flasher probe, SD-image listing
// and device OTA poll lands here, and they must not each cost a GitHub API
// call: unauthenticated api.github.com allows 60 requests/hour per IP, and a
// cloud host shares ONE egress IP across all of its users and frames, so an
// afternoon of flashing was enough to get the whole deployment 403'd. Next's
// own fetch cache (`next: { revalidate }`) is kept as a second layer but is
// not relied on — it caches nothing on failure and is opaque to tests.
//
// Fresh for `releaseFreshMs`; concurrent callers share one in-flight fetch;
// and when GitHub errors (rate limit, outage, network) the last good release
// is served instead — a slightly stale release beats "try again in a minute"
// for someone holding a board in boot mode. Stale-on-error is unbounded on
// purpose: a release list that is hours old is still correct (releases are
// immutable and only ever added to), and the retry keeps running behind it.
export const releaseFreshMs = 5 * 60 * 1000;
// After a failure, back off before asking GitHub again so a 403/429 does not
// turn every request into another counted attempt.
export const releaseRetryMs = 60 * 1000;

type ReleaseCache = {
  release: Release | undefined;
  fetchedAt: number;
  lastAttemptAt: number;
  inFlight: Promise<Release | undefined> | undefined;
};

const releaseCache: ReleaseCache = {
  release: undefined,
  fetchedAt: 0,
  lastAttemptAt: 0,
  inFlight: undefined,
};

function githubReleaseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "frameos-cloud",
  };
  // Optional: a token lifts the API budget from 60/hour/IP to 5000/hour.
  // Read-only public data, so any fine-grained token with no scopes works.
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchLatestReleaseUncached(): Promise<Release | undefined> {
  try {
    const response = await fetch(releaseApiUrl, {
      headers: githubReleaseHeaders(),
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return undefined;
    }
    const release = (await response.json()) as Release;
    return release && typeof release === "object" ? release : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The latest release's metadata: from the in-process cache when fresh, else
 * re-fetched from GitHub, falling back to the last good copy when GitHub
 * fails. Undefined only when there has never been a successful lookup.
 */
export async function fetchLatestRelease(
  now: number = Date.now(),
): Promise<Release | undefined> {
  const cached = releaseCache.release;
  if (cached && now - releaseCache.fetchedAt < releaseFreshMs) {
    return cached;
  }
  if (releaseCache.inFlight) {
    return releaseCache.inFlight;
  }
  // Recently failed with a stale copy in hand: serve that without another
  // counted attempt. With nothing cached at all there is nothing to lose by
  // retrying, so a fresh process behind a hiccup is not stuck for a minute.
  if (
    cached &&
    now - releaseCache.lastAttemptAt < releaseRetryMs &&
    releaseCache.lastAttemptAt > releaseCache.fetchedAt
  ) {
    return cached;
  }

  releaseCache.lastAttemptAt = now;
  const attempt = fetchLatestReleaseUncached().then((release) => {
    if (release) {
      releaseCache.release = release;
      releaseCache.fetchedAt = now;
      return release;
    }
    return releaseCache.release;
  });
  releaseCache.inFlight = attempt;
  try {
    return await attempt;
  } finally {
    releaseCache.inFlight = undefined;
  }
}

/** Forget the cached release (tests only — every suite mocks its own GitHub). */
export function resetReleaseCacheForTests() {
  releaseCache.release = undefined;
  releaseCache.fetchedAt = 0;
  releaseCache.lastAttemptAt = 0;
  releaseCache.inFlight = undefined;
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
//
// `<platform>.bin` must be the OTA APP image (`build/frameos_esp32.bin`), not
// `merged-binary.bin` — see the otaAssets comment above. `version.txt` must
// match the app's version string (esp_app_get_description()->version, i.e.
// what `idf.py build` stamped), or the device sees itself as up to date and
// does nothing.

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
