import { NextRequest } from "next/server";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { authenticateFrameDevice } from "../../../../../../src/lib/frame-device-auth";
import {
  fetchLatestRelease,
  findOtaAsset,
  streamablePlatforms,
  devFirmwareOverride,
  streamDevFirmwareResponse,
  streamReleaseAssetResponse,
} from "../../../../../../src/lib/firmware-release";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// Device-authed firmware download (docs/cloud-frames.md, "Signed OTA"): the
// bytes behind the manifest route's `downloadUrl`, streamed through the same
// host-pinned, never-buffered pipe the browser flasher uses
// (src/lib/firmware-release.ts). Auth is the frame's enrollment bearer, same
// as the manifest; the device hashes the stream incrementally and verifies
// the minisign signature before switching boot slots, so these bytes are
// untrusted until the device itself says otherwise.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  // A device downloads at most one image per released version; the same
  // tight per-client budget the browser flasher's binary pipe has.
  const limited = await rateLimitResponse(request, "frames:device-firmware", {
    limit: 10,
    windowMs: 60 * 60 * 1000,
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
  if (auth.frame.id !== frameId) {
    return jsonError("frame_mismatch", 403);
  }

  const platform = request.nextUrl.searchParams.get("platform");
  if (!platform || !streamablePlatforms.has(platform)) {
    return jsonError("invalid_platform", 400);
  }

  const dev = await devFirmwareOverride(platform);
  if (dev) {
    return streamDevFirmwareResponse(dev);
  }

  const release = await fetchLatestRelease();
  if (!release) {
    return jsonError("release_lookup_failed", 502);
  }
  // Must be the same artifact the manifest described: the bare app image.
  const asset = findOtaAsset(release, platform);
  if (!asset) {
    return jsonError("ota_image_not_published", 404, {
      platform,
      release: release.tag_name ?? null,
    });
  }
  // Same doctrine as the manifest's 409: never hand a device an image the
  // release cannot prove. (The device verifies anyway; this keeps an
  // unsigned release loud instead of quietly wasting a battery frame's
  // download budget.)
  const signatureAsset = release.assets?.find(
    (candidate) => candidate.name === `${asset.name}.minisig`,
  );
  if (!signatureAsset) {
    return jsonError("unsigned_release", 409, {
      platform,
      release: release.tag_name ?? null,
    });
  }

  return streamReleaseAssetResponse(asset, release.tag_name ?? "");
}
