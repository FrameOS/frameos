// Automatic updates for cloud frames (docs/auto-updates.md "Pi under the
// cloud" / "ESP32 under the cloud"). Once an hour the hub asks the update
// decision (auth-web's update-decision.ts over the manifest update-manifest.ts
// reads from GitHub) for every frame that may take an update now, and
// enqueues notify_update_available `{version, auto: true}` for each frame it
// answers with a version. The device does the rest exactly as for the
// owner's Update: a Linux runtime from 2026.11.14 installs that version (an
// older one GitHub's latest), an ESP32 fetches its manifest route, which runs
// the same rule (`auto: true` makes that fetch automatic).
//
// A frame is nudged only when ALL of these hold:
//   - confirmed (`active`), not virtual (nothing to update), not owned by a
//     self-hosted backend (`hardware.backend`: that backend decides);
//   - its owner left automatic updates on (settings.auto_update !== false);
//   - it reported a version the rule can read (a dev build is never nudged);
//   - no deploy, update, restart or reboot is in flight (deploy_progress
//     running and not stale);
//   - no notify_update_available was queued for it in the last 20 hours
//     (automatic or not: an owner who just pressed Update is not nudged);
//   - it is between 02:00 and 05:00 where it is (settings.timezone, UTC when
//     it has none): a frame that is asleep or offline then takes the nudge
//     from the queue when it next connects.
//
// The rule's answer for a Linux frame below 2026.11.14 is used only when it
// is the latest: those runtimes ignore the version and install GitHub's
// latest, so nudging one toward a stepping stone would skip the stone.

import { and, eq, gt, max, sql } from "drizzle-orm";
import { createDb, frameCommands, frames, virtualFrames } from "@frameos-cloud/db";
import { deployProgressIsStale, isDeployProgressRecord } from "../../auth-web/src/lib/deploy-progress";
import { frameOwningBackend } from "../../auth-web/src/lib/frame-backend-owner";
import { enqueueFrameCommand, frameContractProfile } from "../../auth-web/src/lib/frames";
import {
  compareVersionTriples,
  decideUpdate,
  parseVersion,
  type UpdateDecision,
} from "../../auth-web/src/lib/update-decision";
import { fetchUpdateManifest, type UpdateManifest } from "../../auth-web/src/lib/update-manifest";

export const autoUpdateIntervalMs = 60 * 60 * 1000;
// At most one nudge per frame per this long; also the nudge's lifetime on the
// queue (measured from the frame's announced wake for a sleeper).
export const autoUpdateNudgeEveryMs = 20 * 60 * 60 * 1000;
// [fromHour, toHour) in the frame's own time zone.
export const autoUpdateWindow = { fromHour: 2, toHour: 5 } as const;
// The first Linux runtime that installs the version a nudge names.
export const pinnedUpgradeSince = "2026.11.14";

export interface AutoUpdateCandidate {
  id: string;
  accountId: string;
  status: string;
  hardware: unknown;
  frameosVersion: string | null;
  settings: unknown;
  deployProgress: unknown;
  nextWakeAt: Date | null;
  lastNudgeAt: Date | null;
  virtual: boolean;
}

export type AutoUpdateVerdict =
  | { nudge: true; version: string; decision: UpdateDecision }
  | { nudge: false; skip: string; decision?: UpdateDecision };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The hour (0-23) at `now` in `timeZone`, UTC when it is missing or not a zone. */
export function localHour(timeZone: unknown, now: Date): number {
  if (typeof timeZone === "string" && timeZone.trim()) {
    try {
      const hour = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: timeZone.trim(),
      }).format(now);
      const parsed = Number.parseInt(hour, 10);
      if (Number.isFinite(parsed)) {
        return parsed % 24;
      }
    } catch {
      // Not a zone Intl knows: UTC.
    }
  }
  return now.getUTCHours();
}

/**
 * What the rule is asked about: `linux` with the release slug when the hello
 * names one (`hardware.upgradeTarget`; empty otherwise, which `linux/*`
 * patterns still match), `esp32` with its OTA layout (`hardware.otaPlatform`
 * when reported, else the chip's generic image: the manifest route, asked
 * with the board's own layout, has the last word).
 */
export function autoUpdateTarget(hardware: unknown): { platform: "linux" | "esp32"; target: string } {
  const report = record(hardware);
  if (frameContractProfile({ hardware }) === "esp32") {
    if (typeof report.otaPlatform === "string" && report.otaPlatform) {
      return { platform: "esp32", target: report.otaPlatform };
    }
    // firmware-release.ts releasePlatformChip's reading (that module is Next's).
    const chip = typeof report.platform === "string" ? /^(esp32-(?:s3|c3))(?:-|$)/.exec(report.platform)?.[1] : undefined;
    return { platform: "esp32", target: chip ? `${chip}-generic` : "" };
  }
  return {
    platform: "linux",
    target: typeof report.upgradeTarget === "string" ? report.upgradeTarget : "",
  };
}

/** Whether (and to which version) one frame is nudged now. Pure: the sweep's tests pin it. */
export function autoUpdateVerdict(
  frame: AutoUpdateCandidate,
  manifest: UpdateManifest,
  now: Date,
): AutoUpdateVerdict {
  if (frame.status !== "active") {
    return { nudge: false, skip: "not_active" };
  }
  if (frame.virtual) {
    return { nudge: false, skip: "virtual" };
  }
  if (frameOwningBackend(frame.hardware)) {
    return { nudge: false, skip: "backend_managed" };
  }
  const settings = record(frame.settings);
  if (settings.auto_update === false) {
    return { nudge: false, skip: "disabled" };
  }
  const current = parseVersion(frame.frameosVersion);
  if (!current) {
    return { nudge: false, skip: "unknown_version" };
  }
  if (
    isDeployProgressRecord(frame.deployProgress) &&
    frame.deployProgress.status === "running" &&
    !deployProgressIsStale(frame.deployProgress, now, { nextWakeAt: frame.nextWakeAt })
  ) {
    return { nudge: false, skip: "in_flight" };
  }
  if (frame.lastNudgeAt && now.getTime() - frame.lastNudgeAt.getTime() < autoUpdateNudgeEveryMs) {
    return { nudge: false, skip: "recently_nudged" };
  }
  const hour = localHour(settings.timezone, now);
  if (hour < autoUpdateWindow.fromHour || hour >= autoUpdateWindow.toHour) {
    return { nudge: false, skip: "outside_window" };
  }
  const { platform, target } = autoUpdateTarget(frame.hardware);
  const decision = decideUpdate(manifest, {
    channel: "stable",
    current: frame.frameosVersion,
    frameKey: `cloud:${frame.id}`,
    manual: false,
    now: now.toISOString(),
    platform,
    target,
  });
  if (!decision.version) {
    return { nudge: false, skip: decision.reason, decision };
  }
  if (
    platform === "linux" &&
    compareVersionTriples(current, parseVersion(pinnedUpgradeSince)!) < 0 &&
    decision.version !== decision.latest
  ) {
    return { nudge: false, skip: "runtime_installs_latest_only", decision };
  }
  return { nudge: true, version: decision.version, decision };
}

/** The frames the sweep looks at, with when each was last sent an update nudge. */
export async function autoUpdateCandidates(db: ReturnType<typeof createDb>): Promise<AutoUpdateCandidate[]> {
  const lastNudge = db
    .select({
      frameId: frameCommands.frameId,
      lastNudgeAt: max(frameCommands.createdAt).as("last_nudge_at"),
    })
    .from(frameCommands)
    .where(eq(frameCommands.type, "notify_update_available"))
    .groupBy(frameCommands.frameId)
    .as("last_nudge");
  const rows = await db
    .select({
      accountId: frames.accountId,
      deployProgress: frames.deployProgress,
      frameosVersion: frames.frameosVersion,
      hardware: frames.hardware,
      id: frames.id,
      lastNudgeAt: lastNudge.lastNudgeAt,
      nextWakeAt: frames.nextWakeAt,
      settings: frames.settings,
      status: frames.status,
      virtualFrameId: virtualFrames.frameId,
    })
    .from(frames)
    .leftJoin(virtualFrames, eq(virtualFrames.frameId, frames.id))
    .leftJoin(lastNudge, eq(lastNudge.frameId, frames.id))
    .where(and(eq(frames.status, "active"), sql`${frames.frameosVersion} is not null`));
  return rows.map((row) => ({
    accountId: row.accountId,
    deployProgress: row.deployProgress,
    frameosVersion: row.frameosVersion,
    hardware: row.hardware,
    id: row.id,
    lastNudgeAt: row.lastNudgeAt ? new Date(row.lastNudgeAt as unknown as string | Date) : null,
    nextWakeAt: row.nextWakeAt,
    settings: row.settings,
    status: row.status,
    virtual: row.virtualFrameId !== null,
  }));
}

export interface AutoUpdateSweepResult {
  // Frames nudged, with the version each was offered.
  nudged: { frameId: string; version: string; reason: string }[];
  // How many were looked at and skipped, by why.
  skipped: Record<string, number>;
  // No manifest from GitHub or a last good copy: nothing was nudged.
  noManifest?: true;
}

/** One pass: decide for every candidate and enqueue the nudges. */
export async function runAutoUpdateSweep(
  db: ReturnType<typeof createDb>,
  options: {
    now?: Date;
    manifest?: UpdateManifest;
    onNudged?: (frame: AutoUpdateCandidate, version: string, decision: UpdateDecision) => Promise<void> | void;
  } = {},
): Promise<AutoUpdateSweepResult> {
  const now = options.now ?? new Date();
  const result: AutoUpdateSweepResult = { nudged: [], skipped: {} };
  const manifest = options.manifest ?? (await fetchUpdateManifest(now.getTime()));
  if (!manifest) {
    result.noManifest = true;
    return result;
  }
  for (const frame of await autoUpdateCandidates(db)) {
    const verdict = autoUpdateVerdict(frame, manifest, now);
    if (!verdict.nudge) {
      result.skipped[verdict.skip] = (result.skipped[verdict.skip] ?? 0) + 1;
      continue;
    }
    // Re-checked at the write: another hub (or the owner) may have queued one
    // since the candidates were read.
    const [recent] = await db
      .select({ id: frameCommands.id })
      .from(frameCommands)
      .where(
        and(
          eq(frameCommands.frameId, frame.id),
          eq(frameCommands.type, "notify_update_available"),
          gt(frameCommands.createdAt, new Date(now.getTime() - autoUpdateNudgeEveryMs)),
        ),
      )
      .limit(1);
    if (recent) {
      result.skipped.recently_nudged = (result.skipped.recently_nudged ?? 0) + 1;
      continue;
    }
    await enqueueFrameCommand(db, {
      frameId: frame.id,
      payload: { auto: true, version: verdict.version },
      ttlMs: autoUpdateNudgeEveryMs,
      type: "notify_update_available",
    });
    result.nudged.push({ frameId: frame.id, reason: verdict.decision.reason, version: verdict.version });
    await options.onNudged?.(frame, verdict.version, verdict.decision);
  }
  return result;
}
