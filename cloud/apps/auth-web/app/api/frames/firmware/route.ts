import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import {
  fetchLatestRelease,
  findAsset,
  provisioningAssets,
  streamablePlatforms,
  streamReleaseAssetResponse,
  type Release,
} from "../../../../src/lib/firmware-release";
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
// the bytes come from here, same-origin. The GitHub plumbing (allow-list,
// release lookup, host-pinned streaming pipe) lives in
// src/lib/firmware-release.ts, shared with the device-authed OTA routes
// (app/api/frames/[frameId]/firmware).
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

export async function GET(request: NextRequest) {
  const platform = request.nextUrl.searchParams.get("platform");
  const listing = platform === null;

  // The listing is served from the in-process release cache (no GitHub call
  // per request — src/lib/firmware-release.ts), so its budget only needs to
  // fend off abuse. The binary is a multi-megabyte stream through this host,
  // so that one stays bounded — but a debugging session re-flashes a board
  // many times an hour, and every retry after a failed flash counts.
  const limited = listing
    ? await rateLimitResponse(request, "frames:firmware-meta", {
        limit: 300,
        windowMs: 15 * 60 * 1000,
      })
    : await rateLimitResponse(request, "frames:firmware", {
        limit: 30,
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

  const release: Release | undefined = await fetchLatestRelease();
  if (!release) {
    return jsonError("release_lookup_failed", 502);
  }

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
  // Host-pinned and streamed straight through: the route never buffers the
  // firmware (streamReleaseAssetResponse in src/lib/firmware-release.ts).
  return streamReleaseAssetResponse(asset, release.tag_name ?? "");
}
