import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { authenticateFrameDevice } from "../../../../../../src/lib/frame-device-auth";
import {
  devFirmwareOverride,
  fetchLatestRelease,
  fetchReleaseAssetText,
  findOtaAsset,
  streamablePlatforms,
} from "../../../../../../src/lib/firmware-release";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// Device-authed OTA manifest (docs/cloud-frames.md, "Signed OTA"). Called by
// the DEVICE — the enrollment access token as `Authorization: Bearer …`, not
// a browser session — after a notify_update_available nudge, on the device's
// own schedule:
//
//   GET /api/frames/{id}/firmware/manifest?platform=esp32-s3-generic
//   -> { platform, version, size, minisig, downloadUrl }
//
// The image behind it is the release's bare APP binary (`…-app.bin`), not the
// merged flash image the browser flasher writes — an OTA slot accepts nothing
// else (src/lib/firmware-release.ts, otaAssets).
//
// `minisig` is the full text of the release's detached minisign signature
// (tools/sign_firmware.py: Ed25519 over BLAKE2b-512 of the image, verified
// on-device against the public key baked into the firmware BEFORE the boot
// slot switches). The cloud never holds the signing key — it can only relay
// what the release carries, which is exactly the point: a compromised cloud
// cannot turn the update channel into native code execution.
//
// A release whose .bin has no .minisig is answered 409 unsigned_release: the
// device must never be offered an image it could not verify, and a loud
// error here beats a device quietly rejecting the download after the fact.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  // Manifest checks are cheap JSON and happen at most a few times a day per
  // device; the same budget the browser flasher's listing gets.
  const limited = await rateLimitResponse(request, "frames:device-firmware-meta", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const auth = await authenticateFrameDevice(
    db,
    request.headers.get("authorization"),
  );
  if ("response" in auth) {
    return auth.response;
  }
  const { frameId } = await params;
  // The token IS the identity; the path segment must agree with it.
  if (auth.frame.id !== frameId) {
    return jsonError("frame_mismatch", 403);
  }

  const platform = request.nextUrl.searchParams.get("platform");
  if (!platform || !streamablePlatforms.has(platform)) {
    return jsonError("invalid_platform", 400);
  }

  const dev = await devFirmwareOverride(platform);
  if (dev) {
    return NextResponse.json(
      {
        platform,
        version: dev.version,
        size: dev.size,
        minisig: dev.minisig,
        downloadUrl: `/api/frames/${auth.frame.id}/firmware/download?platform=${platform}`,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const release = await fetchLatestRelease();
  if (!release) {
    return jsonError("release_lookup_failed", 502);
  }
  // The bare app image, never the merged flash image: only the former is a
  // valid OTA payload (src/lib/firmware-release.ts, otaAssets).
  const asset = findOtaAsset(release, platform);
  if (!asset) {
    return jsonError("ota_image_not_published", 404, {
      platform,
      release: release.tag_name ?? null,
    });
  }

  const signatureAsset = release.assets?.find(
    (candidate) => candidate.name === `${asset.name}.minisig`,
  );
  if (!signatureAsset) {
    return jsonError("unsigned_release", 409, {
      platform,
      release: release.tag_name ?? null,
    });
  }
  const minisig = await fetchReleaseAssetText(signatureAsset);
  if (!minisig) {
    return jsonError("release_lookup_failed", 502);
  }

  return NextResponse.json(
    {
      platform,
      // Release tags are v-prefixed ("v2026.8.1"); the device compares
      // against esp_app_get_description()->version, which is not.
      version: (release.tag_name ?? "").replace(/^v/, ""),
      size: asset.size,
      minisig,
      downloadUrl: `/api/frames/${auth.frame.id}/firmware/download?platform=${platform}`,
    },
    { headers: { "cache-control": "private, max-age=300" } },
  );
}
