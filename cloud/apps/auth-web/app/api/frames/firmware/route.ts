import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// Provisioning-artifact lookup + ESP32 firmware pipe for the browser flasher
// (docs/cloud-frames.md, "ESP32 browser flashing").
//
// Nothing in the browser may talk to GitHub directly: the 302 from github.com
// carries no access-control-allow-origin (so the download always fails CORS),
// and unauthenticated api.github.com is 60 requests/hour *per IP* — one
// corporate NAT is enough to 403 every user behind it. So both the listing and
// the bytes come from here, same-origin.
//
// Two shapes:
//   GET /api/frames/firmware
//     -> { release, assets: [{ name, platform, size }] } for every provisioning
//        artifact in the latest release. It lists the ESP32 firmware *and* the
//        buildroot SD images on purpose: the SD image builder needs the same
//        listing and must not hit api.github.com either. Only the listing is
//        shared — the SD bytes stream through app/api/frames/sd-image, which
//        has its own (much tighter) budget for gigabyte-sized images.
//   GET /api/frames/firmware?platform=esp32-s3-epd7in5v2
//     -> the .bin bytes, streamed.
//
// Like the SD image route this is a dumb byte pipe over public release
// artifacts, and it is not an "image proxy" in the sense the project forbids:
// that rule is about frame *content* fetched on every render.

const releaseApiUrl =
  "https://api.github.com/repos/FrameOS/frameos/releases/latest";

// Explicit allow-list of platform -> exact asset suffix. The upstream host and
// path are never taken from user input, so this cannot be steered into an SSRF.
// esp32-s3-generic carries every supported panel driver and selects one at
// runtime (`set panel` over serial / NVS); esp32-s3-epd7in5v2 is the older
// single-panel build kept so deployments running this code against an old
// release still flash something. Keep in sync with the esp32 job in
// .github/workflows/docker-publish-multi.yml.
const provisioningAssets = [
  { platform: "esp32-s3-generic", suffix: "-esp32-s3-generic.bin" },
  { platform: "esp32-s3-epd7in5v2", suffix: "-esp32-s3-epd7in5v2.bin" },
  {
    platform: "raspberry-pi-zero-2-w",
    suffix: "-raspberry-pi-zero-2-w-buildroot.img.gz",
  },
  {
    platform: "raspberry-pi-zero-w",
    suffix: "-raspberry-pi-zero-w-buildroot.img.gz",
  },
] as const;

// Only the ESP32 firmware (a few MB) is streamed from here.
const streamablePlatforms = new Set(["esp32-s3-generic", "esp32-s3-epd7in5v2"]);

// Development / self-hosted escape hatch: until a release publishes the
// all-panels build, FRAMEOS_ESP32_GENERIC_FIRMWARE can point at a locally
// built merged binary (embedded/esp32/build*/merged-binary.bin). It is
// advertised and served ONLY when the release itself has no generic asset,
// so a published release always wins. Unset in production deployments.
async function localGenericFirmware(): Promise<
  { name: string; path: string; size: number } | undefined
> {
  const path = process.env.FRAMEOS_ESP32_GENERIC_FIRMWARE?.trim();
  if (!path) {
    return undefined;
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return undefined;
    }
    return { name: basename(path), path, size: info.size };
  } catch {
    return undefined;
  }
}

interface ReleaseAsset {
  browser_download_url: string;
  name: string;
  size: number;
}

interface Release {
  assets?: ReleaseAsset[];
  tag_name?: string;
}

function findAsset(release: Release, suffix: string) {
  return release.assets?.find(
    (entry) => entry.name.startsWith("frameos-") && entry.name.endsWith(suffix),
  );
}

export async function GET(request: NextRequest) {
  const platform = request.nextUrl.searchParams.get("platform");
  const listing = platform === null;

  // The listing is cheap JSON and every page load wants it; the binary is a
  // multi-megabyte download, so keep that budget tight per client.
  const limited = listing
    ? await rateLimitResponse(request, "frames:firmware-meta", {
        limit: 60,
        windowMs: 15 * 60 * 1000,
      })
    : await rateLimitResponse(request, "frames:firmware", {
        limit: 10,
        windowMs: 60 * 60 * 1000,
      });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  if (!listing && !streamablePlatforms.has(platform)) {
    return jsonError("invalid_platform", 400);
  }

  const releaseResponse = await fetch(releaseApiUrl, {
    headers: { accept: "application/vnd.github+json" },
    // Releases change rarely; caching keeps us far from GitHub's rate limit.
    next: { revalidate: 300 },
  });
  if (!releaseResponse.ok) {
    return jsonError("release_lookup_failed", 502);
  }
  const release = (await releaseResponse.json()) as Release;

  if (listing) {
    const assets = provisioningAssets.flatMap((entry) => {
      const asset = findAsset(release, entry.suffix);
      return asset
        ? [{ name: asset.name, platform: entry.platform, size: asset.size }]
        : [];
    });
    if (!assets.some((asset) => asset.platform === "esp32-s3-generic")) {
      const local = await localGenericFirmware();
      if (local) {
        assets.unshift({
          name: local.name,
          platform: "esp32-s3-generic",
          size: local.size,
        });
      }
    }
    return NextResponse.json(
      { assets, release: release.tag_name ?? "" },
      { headers: { "cache-control": "private, max-age=300" } },
    );
  }

  const requested = provisioningAssets.find(
    (entry) => entry.platform === platform,
  );
  const asset = requested ? findAsset(release, requested.suffix) : undefined;
  if (!asset && platform === "esp32-s3-generic") {
    const local = await localGenericFirmware();
    if (local) {
      const bytes = await readFile(local.path);
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "cache-control": "no-store",
          "content-length": String(bytes.length),
          "content-type": "application/octet-stream",
          "x-frameos-image-name": local.name,
          "x-frameos-release": "local-dev",
        },
        status: 200,
      });
    }
  }
  if (!asset) {
    return jsonError("firmware_not_published", 404, {
      platform,
      release: release.tag_name ?? null,
    });
  }
  // Belt and braces: the URL comes from the GitHub API, but pin the host
  // anyway so a compromised/unexpected API response cannot redirect us.
  let assetUrl: URL;
  try {
    assetUrl = new URL(asset.browser_download_url);
  } catch {
    return jsonError("release_lookup_failed", 502);
  }
  if (assetUrl.protocol !== "https:" || assetUrl.host !== "github.com") {
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
    "x-frameos-release": release.tag_name ?? "",
  });
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) {
    headers.set("content-length", contentLength);
  }
  // Streamed straight through: the route never buffers the firmware.
  return new NextResponse(upstream.body, { headers, status: 200 });
}
