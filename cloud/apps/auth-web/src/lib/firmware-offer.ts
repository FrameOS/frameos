// What an ESP32 asking for an OTA manifest is offered (docs/auto-updates.md):
// the update decision (update-decision.ts) over the update manifest
// (update-manifest.ts), turned into the manifest shape the firmware reads
// (embedded/esp32/main/fos_ota.c ota_fetch_manifest). Shared by the
// device-authed /api/frames/{id}/firmware/manifest (a cloud frame) and the
// public /api/updates/firmware (a board with no plane).
//
// The firmware installs whatever version the manifest names (it refuses only
// a downgrade and an image not signed as that version for its layout), so
// "nothing to install" is answered as its own running version: the firmware
// checks every field's type first, then logs `up-to-date` on an exact match
// (fos_version_same_release is a strcmp), which is why the running version
// is echoed as the frame reported it, never normalized.

import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { createDb, frameCommands } from "@frameos-cloud/db";
import { jsonError } from "./device-flow";
import {
  fetchLatestRelease,
  fetchReleaseAssetText,
  fetchReleaseForVersion,
  findOtaAsset,
  type Release,
  releaseVersion,
} from "./firmware-release";
import { decideUpdate, type UpdateDecision } from "./update-decision";
import { fetchUpdateManifest } from "./update-manifest";

export type FirmwareOffer =
  | { kind: "release"; release: Release; decision: UpdateDecision | null }
  | { kind: "none"; reason: string; decision: UpdateDecision | null }
  | { kind: "error"; error: "release_lookup_failed" };

/**
 * The release to offer a board on layout `platform` running `current`, or
 * why none.
 *
 * - automatic and the owner turned automatic updates off: none ("disabled");
 * - no manifest (GitHub and the last good copy both missing): a manual check
 *   gets the latest release, as before automatic updates existed; an
 *   automatic one gets nothing ("no_manifest": fail closed);
 * - otherwise the decision: its version, or, for a manual check of a board
 *   whose version does not parse, the latest release (the board refuses a
 *   downgrade itself), or nothing.
 */
export async function firmwareOffer(input: {
  platform: string;
  current: string | null | undefined;
  frameKey: string;
  manual: boolean;
  autoUpdateEnabled: boolean;
  now?: Date;
}): Promise<FirmwareOffer> {
  if (!input.manual && !input.autoUpdateEnabled) {
    return { kind: "none", reason: "disabled", decision: null };
  }
  const now = input.now ?? new Date();
  const manifest = await fetchUpdateManifest(now.getTime());
  if (!manifest) {
    if (!input.manual) {
      return { kind: "none", reason: "no_manifest", decision: null };
    }
    return latestOffer(null);
  }
  const decision = decideUpdate(manifest, {
    channel: "stable",
    current: input.current ?? "",
    frameKey: input.frameKey,
    manual: input.manual,
    now: now.toISOString(),
    platform: "esp32",
    target: input.platform,
  });
  if (decision.version) {
    const release = await fetchReleaseForVersion(decision.version, now.getTime());
    return release ? { kind: "release", release, decision } : { kind: "error", error: "release_lookup_failed" };
  }
  if (decision.reason === "unknown_version" && input.manual) {
    return latestOffer(decision);
  }
  return { kind: "none", reason: decision.reason, decision };
}

async function latestOffer(decision: UpdateDecision | null): Promise<FirmwareOffer> {
  const release = await fetchLatestRelease();
  return release ? { kind: "release", release, decision } : { kind: "error", error: "release_lookup_failed" };
}

function decisionFields(decision: UpdateDecision | null) {
  return decision ? { reason: decision.reason, latest: decision.latest, held: decision.held } : {};
}

/** The answer for "nothing to install": the board's own version. */
export function nothingToInstallResponse(
  platform: string,
  current: string,
  reason: string,
  decision: UpdateDecision | null,
): NextResponse {
  return NextResponse.json(
    {
      platform,
      version: current,
      size: 1,
      minisig: "",
      downloadUrl: "",
      update: false,
      ...decisionFields(decision),
      reason,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * The OTA manifest for `release` on `platform`: `{platform, version, size,
 * minisig, downloadUrl}` (+ the decision's reason, latest and held). 404
 * ota_image_not_published / 409 unsigned_release / 502 release_lookup_failed
 * as the firmware routes always answered.
 */
export async function releaseManifestResponse(
  release: Release,
  platform: string,
  downloadPath: string,
  decision: UpdateDecision | null,
): Promise<NextResponse> {
  // The bare app image, never the merged flash image: only the former is a
  // valid OTA payload (firmware-release.ts, otaAssets).
  const asset = findOtaAsset(release, platform);
  if (!asset) {
    return jsonError("ota_image_not_published", 404, {
      platform,
      release: release.tag_name ?? null,
    });
  }
  const signatureAsset = release.assets?.find((candidate) => candidate.name === `${asset.name}.minisig`);
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
  const version = releaseVersion(release);
  return NextResponse.json(
    {
      platform,
      version,
      size: asset.size,
      minisig,
      downloadUrl: `${downloadPath}?platform=${platform}&version=${version}`,
      ...decisionFields(decision),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/** The release a download asks for (`version`), else the latest. */
export async function releaseForDownload(version: string | null): Promise<Release | undefined> {
  return version ? fetchReleaseForVersion(version) : fetchLatestRelease();
}

// How long a sweep's nudge makes the frame's next manifest fetch automatic.
// A fetch long after it (the board's own settings page asked, the owner at
// the frame) is the owner's.
export const automaticNudgeWindowMs = 24 * 60 * 60 * 1000;

/**
 * Whether a cloud frame's manifest fetch answers the hub's automatic sweep:
 * the newest notify_update_available on its queue was the sweep's (`auto:
 * true`) and recent. Anything else — the owner's Update, the fleet update,
 * the MCP tool, the board's own check — is manual.
 */
export async function frameUpdateCheckIsAutomatic(
  db: ReturnType<typeof createDb>,
  frameId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ createdAt: frameCommands.createdAt, payload: frameCommands.payload })
    .from(frameCommands)
    .where(and(eq(frameCommands.frameId, frameId), eq(frameCommands.type, "notify_update_available")))
    .orderBy(desc(frameCommands.createdAt))
    .limit(1);
  if (!row) {
    return false;
  }
  const payload = row.payload;
  const auto =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).auto === true
      : false;
  return auto && now.getTime() - row.createdAt.getTime() < automaticNudgeWindowMs;
}

/** A frame's auto_update switch from its settings mirror: absent = on. */
export function frameAutoUpdateEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return true;
  }
  return (settings as Record<string, unknown>).auto_update !== false;
}
