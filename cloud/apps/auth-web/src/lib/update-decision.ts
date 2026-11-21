// The update decision (docs/auto-updates.md): given the update manifest
// (docs/update-manifest.json) and a frame — the version it runs, its platform
// and target, its cohort key, its channel — which version may it install now?
//
// One rule, three ports pinned by docs/update-decision-fixtures.json: the
// backend's backend/app/utils/update_decision.py (the reference), this file,
// and the Linux runtime's frameos/src/frameos/update_decision.nim (for a
// frame with no control plane). An ESP32 never runs it: it asks its plane,
// or the public /api/updates/firmware when it has none. Change the three and
// the corpus together (update-decision.test.ts replays it here).
//
// Server-side only (node:crypto): the device routes, the public update
// routes and the frame hub's sweep import it, never the SPA.

import { createHash } from "node:crypto";

export const updateChannels = ["stable", "early"] as const;
export type UpdateChannel = (typeof updateChannels)[number];
export const cohortBuckets = 10000;

export type VersionTriple = [number, number, number];

export interface UpdateRequest {
  current?: unknown;
  platform?: unknown;
  target?: unknown;
  frameKey?: unknown;
  channel?: unknown;
  manual?: unknown;
  now?: unknown;
  maxVersion?: unknown;
}

export type UpdateHoldWhy = "blocked" | "scheduled" | "rollout" | "needs" | "paused";

export interface UpdateHold {
  version: string;
  why: UpdateHoldWhy;
  detail: string;
}

export type UpdateReason =
  | "latest"
  | "stepping_stone"
  | "held_back"
  | "up_to_date"
  | "held"
  | "paused"
  | "unknown_version";

export interface UpdateDecision {
  version: string | null;
  reason: UpdateReason;
  latest: string | null;
  held: UpdateHold | null;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * `2026.11.13` (a leading `v` and a `+build` suffix allowed) as a triple, or
 * null for anything else ("dev", "unknown", two fields).
 */
export function parseVersion(value: unknown): VersionTriple | null {
  if (typeof value !== "string") {
    return null;
  }
  let text = value.trim();
  if (text.startsWith("v")) {
    text = text.slice(1);
  }
  text = text.split("+", 1)[0] ?? "";
  const parts = text.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const out: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,9}$/.test(part)) {
      return null;
    }
    out.push(Number(part));
  }
  return [out[0]!, out[1]!, out[2]!];
}

export function versionText(parsed: VersionTriple): string {
  return `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
}

export function compareVersionTriples(left: VersionTriple, right: VersionTriple): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

const isoTime =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/;

/**
 * An ISO 8601 time (`Z` or an offset; a bare one is UTC) as unix seconds, or
 * null. The reference reads it with Python's datetime.fromisoformat; this
 * accepts the forms the manifest and the corpus use.
 */
export function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const match = isoTime.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, y, mo, d, h = "0", mi = "0", s = "0", fraction = "", , sign, oh = "0", om = "0"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) {
    return null;
  }
  let seconds = ms / 1000 + (fraction ? Number(`0.${fraction}`) : 0);
  if (sign) {
    const offset = (Number(oh) * 60 + Number(om)) * 60;
    seconds += sign === "+" ? -offset : offset;
  }
  return seconds;
}

/**
 * 0 … 9999: where this frame stands in the rollout of `version`. Salted by
 * the version, so the first tenth of one release is not the first tenth of
 * the next.
 */
export function cohortBucket(frameKey: string, version: string): number {
  const digest = createHash("sha256").update(`${frameKey}/${version}`, "utf8").digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) % cohortBuckets;
}

/** The buckets below this are in a rollout at `percent`. */
export function cohortThreshold(percent: number): number {
  return Math.floor((percent * cohortBuckets) / 100 + 0.5);
}

export function patternMatches(pattern: unknown, key: string): boolean {
  if (typeof pattern !== "string" || !pattern) {
    return false;
  }
  if (pattern.endsWith("*")) {
    return key.startsWith(pattern.slice(0, -1));
  }
  return pattern === key;
}

/**
 * How far the release's rollout has come at `now` (unix seconds): the
 * largest stage percent whose time has come, frozen at `pausedAt`. No
 * stages = 100.
 */
export function rolloutPercent(release: JsonObject, defaultRollout: unknown, now: number): number {
  let stages: unknown[] = [];
  if (Array.isArray(release.rollout)) {
    stages = release.rollout;
  } else if (Array.isArray(defaultRollout)) {
    stages = defaultRollout;
  }
  const start = parseTime(release.at);
  if (start === null) {
    return 0;
  }
  let moment = now;
  const pausedAt = parseTime(release.pausedAt);
  if (pausedAt !== null && pausedAt < moment) {
    moment = pausedAt;
  }
  if (moment < start) {
    return 0;
  }
  if (stages.length === 0) {
    return 100;
  }
  let percent = 0;
  for (const stage of stages) {
    if (!isObject(stage)) {
      continue;
    }
    const after = stage.afterHours ?? 0;
    const value = stage.percent ?? 0;
    if (!isNumber(after) || !isNumber(value)) {
      continue;
    }
    if (start + after * 3600 <= moment) {
      percent = Math.max(percent, value);
    }
  }
  return Math.max(0, Math.min(100, percent));
}

function blockedReason(release: JsonObject, key: string): string | null {
  const blocked = release.blocked;
  if (typeof blocked === "string" && blocked) {
    return blocked;
  }
  if (blocked === true) {
    return "blocked";
  }
  const targets = release.blockedTargets;
  if (isObject(targets)) {
    for (const [pattern, reason] of Object.entries(targets)) {
      if (patternMatches(pattern, key)) {
        return typeof reason === "string" && reason ? reason : "blocked for this target";
      }
    }
  }
  return null;
}

function visible(release: JsonObject, key: string, channel: string): boolean {
  const channels = release.channels;
  if (Array.isArray(channels) && !channels.includes(channel)) {
    return false;
  }
  const targets = release.targets;
  if (Array.isArray(targets) && !targets.some((pattern) => patternMatches(pattern, key))) {
    return false;
  }
  return true;
}

function formatPercent(percent: number): string {
  return Number.isInteger(percent) ? String(percent) : String(Number(percent.toPrecision(6)));
}

/**
 * The decision for one frame. `request`: current, platform, target,
 * frameKey, channel ("stable" | "early"; anything else is stable), manual (an
 * owner asked: the rollout is skipped, blocks and stepping stones are not),
 * now (ISO time), maxVersion (a ceiling: releases above it do not exist for
 * this frame).
 */
export function decideUpdate(manifest: unknown, request: UpdateRequest): UpdateDecision {
  const doc = isObject(manifest) ? manifest : {};
  const releasesRaw = Array.isArray(doc.releases) ? doc.releases : [];
  const platform = request.platform ? String(request.platform) : "";
  const target = request.target ? String(request.target) : "";
  const key = `${platform}/${target}`;
  const channel: UpdateChannel =
    typeof request.channel === "string" && (updateChannels as readonly string[]).includes(request.channel)
      ? (request.channel as UpdateChannel)
      : "stable";
  const manual = Boolean(request.manual);
  const frameKey = request.frameKey ? String(request.frameKey) : "";
  const now = parseTime(request.now) ?? Date.now() / 1000;
  const ceiling = request.maxVersion ? parseVersion(request.maxVersion) : null;

  const releases: [VersionTriple, JsonObject][] = [];
  const seen = new Set<string>();
  for (const release of releasesRaw) {
    if (!isObject(release)) {
      continue;
    }
    const parsed = parseVersion(release.version);
    if (parsed === null || seen.has(versionText(parsed))) {
      continue;
    }
    if (ceiling !== null && compareVersionTriples(parsed, ceiling) > 0) {
      continue;
    }
    if (!visible(release, key, channel)) {
      continue;
    }
    seen.add(versionText(parsed));
    releases.push([parsed, release]);
  }
  releases.sort((left, right) => compareVersionTriples(left[0], right[0]));

  const latest = releases.length > 0 ? releases[releases.length - 1]![0] : null;
  const latestText = latest ? versionText(latest) : null;
  const current = parseVersion(request.current);

  const answer = (version: string | null, reason: UpdateReason, held: UpdateHold | null = null): UpdateDecision => ({
    version,
    reason,
    latest: latestText,
    held,
  });

  if (current === null) {
    return answer(null, "unknown_version");
  }
  if (latest === null || compareVersionTriples(latest, current) <= 0) {
    return answer(null, "up_to_date");
  }
  const paused = doc.paused;
  if (typeof paused === "string" && paused) {
    return answer(null, "paused", { version: latestText!, why: "paused", detail: paused });
  }

  const minFrom = (index: number): VersionTriple | null => {
    const [, release] = releases[index]!;
    let floor = parseVersion(release.minFrom);
    for (const [earlier, other] of releases.slice(0, index)) {
      if (other.steppingStone === true && (floor === null || compareVersionTriples(earlier, floor) > 0)) {
        floor = earlier;
      }
    }
    return floor;
  };

  const hold = (index: number): UpdateHold | null => {
    const [parsed, release] = releases[index]!;
    const text = versionText(parsed);
    const blocked = blockedReason(release, key);
    if (blocked) {
      return { version: text, why: "blocked", detail: blocked };
    }
    const start = parseTime(release.at);
    if (start === null || start > now) {
      return { version: text, why: "scheduled", detail: `rolls out from ${String(release.at ?? "an unset time")}` };
    }
    if (!manual && channel !== "early") {
      const percent = rolloutPercent(release, doc.defaultRollout, now);
      const inCohort =
        percent >= 100 || (frameKey !== "" && cohortBucket(frameKey, text) < cohortThreshold(percent));
      if (!inCohort) {
        return {
          version: text,
          why: "rollout",
          detail: `rolling out to ${formatPercent(percent)}% of frames; this one is in a later stage`,
        };
      }
    }
    const floor = minFrom(index);
    if (floor !== null && compareVersionTriples(current, floor) < 0) {
      return { version: text, why: "needs", detail: `needs ${versionText(floor)} first` };
    }
    return null;
  };

  const latestHold = hold(releases.length - 1);
  if (latestHold === null) {
    return answer(latestText, "latest");
  }
  for (let index = releases.length - 2; index >= 0; index -= 1) {
    const parsed = releases[index]![0];
    if (compareVersionTriples(parsed, current) <= 0) {
      break;
    }
    if (hold(index) === null) {
      return answer(versionText(parsed), latestHold.why === "needs" ? "stepping_stone" : "held_back", latestHold);
    }
  }
  return answer(null, "held", latestHold);
}
