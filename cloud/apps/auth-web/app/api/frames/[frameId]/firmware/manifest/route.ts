import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { authenticateFrameDevice } from "../../../../../../src/lib/frame-device-auth";
import {
  devFirmwareOverride,
  otaPlatformMatchesHardware,
  streamablePlatforms,
} from "../../../../../../src/lib/firmware-release";
import {
  firmwareOffer,
  frameAutoUpdateEnabled,
  frameUpdateCheckIsAutomatic,
  nothingToInstallResponse,
  releaseManifestResponse,
} from "../../../../../../src/lib/firmware-offer";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// Device-authed OTA manifest (docs/cloud-frames.md, "Signed OTA"). Called by
// the DEVICE — the enrollment access token as `Authorization: Bearer …`, not
// a browser session — after a notify_update_available nudge, on the device's
// own schedule:
//
//   GET /api/frames/{id}/firmware/manifest?platform=esp32-s3-generic[&version=<running>]
//   -> { platform, version, size, minisig, downloadUrl, reason?, latest?, held? }
//
// The version offered is the update decision's (docs/auto-updates.md,
// src/lib/firmware-offer.ts): the latest, a stepping stone, an older release
// while the latest is blocked or still rolling out — or, when there is
// nothing to install, the board's own version, which it logs as up-to-date.
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

const deviceManifestBudget = { limit: 60, windowMs: 15 * 60 * 1000 };
// How many frames one address's budget is sized for (download route too).
const fleetBehindOneAddress = 20;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  // Manifest checks are cheap JSON and happen at most a few times a day per
  // device; the same budget the browser flasher's listing gets, per FRAME.
  // The per-address budget in front of it only bounds what a caller can make
  // this route do before the bearer is looked at, so it is a fleet's worth: a
  // school or an office puts every frame behind one NAT address, and a
  // per-address budget alone let one chatty frame starve the rest.
  const limited = await rateLimitResponse(request, "frames:device-firmware-meta", {
    limit: deviceManifestBudget.limit * fleetBehindOneAddress,
    windowMs: deviceManifestBudget.windowMs,
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
  const frameLimited = await identityRateLimitResponse(
    auth.frame.id,
    "frames:device-firmware-meta",
    deviceManifestBudget,
  );
  if (frameLimited) {
    return frameLimited;
  }

  const platform = request.nextUrl.searchParams.get("platform");
  if (!platform || !streamablePlatforms.has(platform)) {
    return jsonError("invalid_platform", 400);
  }
  // The device chooses the image; the frame row says what chip it is.
  if (!otaPlatformMatchesHardware(platform, auth.frame.hardware)) {
    return jsonError("platform_mismatch", 409, { platform });
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

  // What to offer is the update decision's (docs/auto-updates.md): the
  // hub's sweep nudged this frame (automatic: the rollout, the owner's
  // switch) or somebody asked (manual: blocks and stepping stones only).
  // The board's running version is the one it names, else what it reported.
  const versionParam = request.nextUrl.searchParams.get("version")?.trim();
  const current = (versionParam || auth.frame.frameosVersion || "").replace(/^v/, "");
  const manual = !(await frameUpdateCheckIsAutomatic(db, auth.frame.id));
  const offer = await firmwareOffer({
    autoUpdateEnabled: frameAutoUpdateEnabled(auth.frame.settings),
    current,
    frameKey: `cloud:${auth.frame.id}`,
    manual,
    platform,
  });
  if (offer.kind === "error") {
    return jsonError(offer.error, 502);
  }
  if (offer.kind === "none") {
    return nothingToInstallResponse(platform, current, offer.reason, offer.decision);
  }
  return releaseManifestResponse(
    offer.release,
    platform,
    `/api/frames/${auth.frame.id}/firmware/download`,
    offer.decision,
  );
}
