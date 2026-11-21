import { NextRequest } from "next/server";
import { jsonError } from "../../../../../src/lib/device-flow";
import { releaseForDownload } from "../../../../../src/lib/firmware-offer";
import {
  findOtaAsset,
  otaAssets,
  resumeRangeStart,
  streamReleaseAssetResponse,
} from "../../../../../src/lib/firmware-release";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// The image behind /api/updates/firmware's downloadUrl, for an ESP32 with no
// control plane (docs/auto-updates.md "Standalone ESP32"): the named
// release's bare `-app.bin` for that layout, streamed from GitHub through the
// same host-pinned, never-buffered pipe the device-authed route uses, a
// resume (`Range: bytes=<written>-`) answered 206. Only a release's signed
// OTA image, never anything else: the board verifies the bytes against the
// release key before it switches its boot slot.
//
//   GET /api/updates/firmware/download?platform=esp32-s3-generic&version=2026.11.14

// One image per release per board, plus resumes (the firmware stops a run at
// 8 connections); a fleet's worth behind one address.
const firmwareDownloadBudget = { limit: 200, windowMs: 60 * 60 * 1000 };
const otaPlatforms = new Set<string>(otaAssets.map((entry) => entry.platform));

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "updates:firmware", firmwareDownloadBudget);
  if (limited) {
    return limited;
  }
  const params = request.nextUrl.searchParams;
  const platform = params.get("platform") ?? "";
  if (!otaPlatforms.has(platform)) {
    return jsonError("invalid_platform", 400);
  }
  const version = params.get("version");
  if (!version || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(version)) {
    return jsonError("invalid_version", 400);
  }
  const release = await releaseForDownload(version);
  if (!release) {
    return jsonError("release_lookup_failed", 502);
  }
  const asset = findOtaAsset(release, platform);
  if (!asset) {
    return jsonError("ota_image_not_published", 404, { platform, release: release.tag_name ?? null });
  }
  if (!release.assets?.some((candidate) => candidate.name === `${asset.name}.minisig`)) {
    return jsonError("unsigned_release", 409, { platform, release: release.tag_name ?? null });
  }
  return streamReleaseAssetResponse(asset, release.tag_name ?? "", resumeRangeStart(request.headers.get("range")));
}
