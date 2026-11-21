import { NextRequest } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import {
  firmwareOffer,
  nothingToInstallResponse,
  releaseManifestResponse,
} from "../../../../src/lib/firmware-offer";
import { otaAssets } from "../../../../src/lib/firmware-release";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// The OTA manifest for an ESP32 with no control plane (docs/auto-updates.md
// "Standalone ESP32"): the update decision, answered in the shape the
// firmware already reads (embedded/esp32/main/fos_ota.c ota_fetch_manifest).
// Public — a standalone board has no credential — and the cloud is only the
// messenger: the image is minisign-verified on the board against the release
// key baked into its firmware, as on every other OTA path.
//
//   GET /api/updates/firmware?platform=esp32-s3-generic&version=<running>
//       &key=<cohort key>[&manual=1]
//   -> { platform, version, size, minisig, downloadUrl, reason, latest, held }
//
// Nothing to install: the board's own version back (size 1, empty minisig
// and downloadUrl), which the firmware logs as up-to-date. downloadUrl is
// relative, /api/updates/firmware/download on this same origin: the board's
// HTTP client pins the address it checked and cannot follow GitHub's
// redirect to its CDN.

// A board checks once a day (and an owner at its console now and then);
// a school's worth of boards behind one address fits easily.
const firmwareMetaBudget = { limit: 120, windowMs: 15 * 60 * 1000 };
const otaPlatforms = new Set<string>(otaAssets.map((entry) => entry.platform));

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "updates:firmware-meta", firmwareMetaBudget);
  if (limited) {
    return limited;
  }
  const params = request.nextUrl.searchParams;
  const platform = params.get("platform") ?? "";
  if (!otaPlatforms.has(platform)) {
    return jsonError("invalid_platform", 400);
  }
  const current = (params.get("version") ?? "").trim().slice(0, 64).replace(/^v/, "");
  const key = (params.get("key") ?? "").trim().slice(0, 128);
  const manual = params.get("manual") === "1" || params.get("manual") === "true";
  // The board decides by its own switch (NVS auto_update) whether to ask at
  // all; when it asks, automatic updates are on.
  const offer = await firmwareOffer({
    autoUpdateEnabled: true,
    current,
    frameKey: key,
    manual,
    platform,
  });
  if (offer.kind === "error") {
    return jsonError(offer.error, 502);
  }
  if (offer.kind === "none") {
    return nothingToInstallResponse(platform, current, offer.reason, offer.decision);
  }
  return releaseManifestResponse(offer.release, platform, "/api/updates/firmware/download", offer.decision);
}
