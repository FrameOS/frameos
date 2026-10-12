// The frame row's `deploy_progress`: how far a deploy, update, restart or
// reboot has come, from the click to the first render on the new code.
//
// The contract is docs/deploy-progress-contract.json (prose:
// docs/deploy-progress.md; corpus: docs/deploy-progress-fixtures.json) and
// the tables here come from it (deploy-progress.gen.ts). The self-hosted
// backend's app/utils/deploy_progress.py is the sibling fold; the shared
// workspace draws the bar from the same tables (frontend/src/decorators/frame.tsx).
//
// Free of Next imports on purpose: the frame hub imports this file by
// relative path, like lib/frames.ts.
//
// One record per frame, replaced by the next deploy. Two ways it moves:
//   advanceDeployProgress(record, stage)   the control plane's own step:
//                                          forward only along the kind's list.
//   foldDeployProgress(record, signal)     something observed: a device log
//                                          line, a command-queue state change,
//                                          the hub's hello or render announce.
// A signal the current stage does not list is ignored, so a late line from
// the previous runtime cannot move the record. The record never expires
// itself: `at` is what a reader compares with the stage's staleAfterSeconds.
import {
  deployProgressContract,
  type DeployProgressKind,
  type DeployProgressStage,
  type DeployProgressStatus,
} from "./deploy-progress.gen";

export interface DeployProgressRecord {
  id: string;
  kind: string;
  stage: string;
  status: DeployProgressStatus;
  detail: string | null;
  progress: { current: number; total: number } | null;
  version: string | null;
  error: string | null;
  started_at: string;
  at: string;
}

const detailMaxLength = 200;
const errorMaxLength = 400;
const idMaxLength = 128;
const versionMaxLength = 64;

// ESP32 `ota:<plane>` statuses -> contract signals.
const otaSignals: Record<string, string> = {
  waiting: "ota:waiting",
  downloading: "ota:downloading",
  progress: "ota:progress",
  verified: "ota:verified",
  "up-to-date": "ota:up-to-date",
  skipped: "ota:up-to-date",
  "downgrade-refused": "ota:up-to-date",
  error: "ota:error",
  "gave-up": "ota:error",
};

// Pi `cloud:upgrade` (upgrade-status.json) statuses -> contract signals.
const upgradeSignals: Record<string, string> = {
  starting: "upgrade:downloading",
  scheduled: "upgrade:downloading",
  running: "upgrade:downloading",
  success: "upgrade:verified",
  reboot_required: "upgrade:verified",
  up_to_date: "upgrade:up-to-date",
  skipped: "upgrade:up-to-date",
  error: "upgrade:error",
  failed: "upgrade:error",
  stalled: "upgrade:error",
};

function clip(value: unknown, limit: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text ? text.slice(0, limit) : null;
}

function kindStages(kind: string) {
  return deployProgressContract.kinds[kind as DeployProgressKind]?.stages ?? [];
}

function kindStageNames(kind: string): string[] {
  return kindStages(kind).map((entry) => entry.stage);
}

function stageIndex(kind: string, stage: unknown): number {
  return typeof stage === "string" ? kindStageNames(kind).indexOf(stage) : -1;
}

export function isDeployProgressRecord(value: unknown): value is DeployProgressRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.kind === "string" &&
    record.kind in deployProgressContract.kinds &&
    typeof record.stage === "string" &&
    (record.status === "running" || record.status === "done" || record.status === "error")
  );
}

/** The kind a queued verb starts for a frame of `profile` (esp32 | linux). */
export function deployProgressKindForCommand(
  type: string,
  profile: "esp32" | "linux",
): DeployProgressKind | undefined {
  switch (type) {
    case "set_scenes":
      return "cloud_scenes";
    case "notify_update_available":
      return profile === "esp32" ? "firmware" : "upgrade";
    case "reboot":
      return "reboot";
    case "restart_runtime":
      return "restart";
    default:
      return undefined;
  }
}

/** A fresh running record at the kind's first stage (or `stage`). */
export function startDeployProgress(
  kind: DeployProgressKind,
  input: { id: string; now: Date; stage?: string; detail?: string | null; version?: string | null },
): DeployProgressRecord {
  const names = kindStageNames(kind);
  const first = input.stage ?? names[0];
  if (!first || !names.includes(first)) {
    throw new Error(`Stage ${String(first)} is not part of deploy progress kind ${kind}`);
  }
  const at = input.now.toISOString();
  return {
    id: clip(input.id, idMaxLength) ?? "deploy",
    kind,
    stage: first,
    status: "running",
    detail: clip(input.detail, detailMaxLength),
    progress: null,
    version: clip(input.version, versionMaxLength),
    error: null,
    started_at: at,
    at,
  };
}

function moved(record: DeployProgressRecord, now: Date, changes: Partial<DeployProgressRecord>): DeployProgressRecord {
  return { ...record, ...changes, at: now.toISOString() };
}

/**
 * The control plane reached `stage` of its own work. Forward only: a record
 * already past it is left alone, except that `detail` still refreshes the
 * caption when the record is in exactly that stage. With `kind`, only a
 * record of that kind moves. undefined means no change.
 */
export function advanceDeployProgress(
  record: unknown,
  stage: string,
  input: { now: Date; detail?: string | null; version?: string | null; kind?: string },
): DeployProgressRecord | undefined {
  if (!isDeployProgressRecord(record) || record.status !== "running") {
    return undefined;
  }
  if (input.kind !== undefined && record.kind !== input.kind) {
    return undefined;
  }
  const current = stageIndex(record.kind, record.stage);
  const target = stageIndex(record.kind, stage);
  if (target < 0 || target < current) {
    return undefined;
  }
  const changes: Partial<DeployProgressRecord> = {};
  if (target > current) {
    changes.stage = stage;
    changes.progress = null;
  }
  if (input.detail !== undefined && input.detail !== null) {
    changes.detail = clip(input.detail, detailMaxLength);
  } else if (target > current) {
    changes.detail = null;
  }
  if (input.version) {
    changes.version = clip(input.version, versionMaxLength);
  }
  if (Object.keys(changes).length === 0) {
    return undefined;
  }
  return moved(record, input.now, changes);
}

export function finishDeployProgress(
  record: unknown,
  input: { now: Date; detail?: string | null },
): DeployProgressRecord | undefined {
  if (!isDeployProgressRecord(record) || record.status !== "running") {
    return undefined;
  }
  return moved(record, input.now, {
    stage: "done",
    status: "done",
    progress: null,
    detail: input.detail !== undefined && input.detail !== null ? clip(input.detail, detailMaxLength) : record.detail,
  });
}

export function failDeployProgress(
  record: unknown,
  error: string,
  input: { now: Date },
): DeployProgressRecord | undefined {
  if (!isDeployProgressRecord(record) || record.status !== "running") {
    return undefined;
  }
  return moved(record, input.now, { status: "error", error: clip(error, errorMaxLength) ?? "failed" });
}

/** An observed signal (the contract's `signals`). undefined when the current stage does not list it. */
export function foldDeployProgress(
  record: unknown,
  signal: string,
  input: { now: Date; detail?: string | null; progress?: { current: number; total: number } | null },
): DeployProgressRecord | undefined {
  if (!isDeployProgressRecord(record) || record.status !== "running") {
    return undefined;
  }
  const entry = kindStages(record.kind).find((candidate) => candidate.stage === record.stage);
  if (!entry) {
    return undefined;
  }
  if (entry.holdOn?.includes(signal)) {
    return moved(record, input.now, {
      detail: input.detail !== undefined && input.detail !== null ? clip(input.detail, detailMaxLength) : record.detail,
      progress: input.progress !== undefined && input.progress !== null ? input.progress : record.progress,
    });
  }
  const target = entry.on?.[signal];
  if (target === undefined) {
    return undefined;
  }
  if (target === "done") {
    return finishDeployProgress(record, { now: input.now, detail: input.detail ?? null });
  }
  if (target === "error") {
    return failDeployProgress(record, input.detail ?? signal, { now: input.now });
  }
  return moved(record, input.now, {
    stage: target,
    progress: input.progress ?? null,
    detail: clip(input.detail, detailMaxLength),
  });
}

/** The contract signals one device log line carries, as [signal, detail, progress]. */
export function deployProgressSignalsForLog(
  payload: unknown,
): Array<[string, string | null, { current: number; total: number } | null]> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const line = payload as Record<string, unknown>;
  const event = line.event;
  if (typeof event !== "string") {
    return [];
  }
  if (event === "bootup" || event === "reload" || event === "render:done") {
    return [[event, null, null]];
  }
  const status = line.status;
  if (event.startsWith("ota:") && typeof status === "string") {
    const signal = otaSignals[status];
    if (!signal) {
      return [];
    }
    let detail = typeof line.detail === "string" ? line.detail : null;
    let progress: { current: number; total: number } | null = null;
    if (signal === "ota:progress" && detail) {
      const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(detail);
      if (match) {
        progress = { current: Number(match[1]), total: Number(match[2]) };
        detail = null;
      }
    }
    if (signal === "ota:downloading" && detail) {
      detail = `downloading ${detail}`;
    }
    return [[signal, detail, progress]];
  }
  if (event === "cloud:upgrade" && typeof status === "string") {
    const signal = upgradeSignals[status];
    if (!signal) {
      return [];
    }
    return [[signal, typeof line.message === "string" ? line.message : null, null]];
  }
  return [];
}

/** Fold every signal one device log line carries. undefined when nothing moved. */
export function foldDeployProgressLog(
  record: unknown,
  payload: unknown,
  input: { now: Date },
): DeployProgressRecord | undefined {
  let result: DeployProgressRecord | undefined;
  let current = record;
  for (const [signal, detail, progress] of deployProgressSignalsForLog(payload)) {
    const next = foldDeployProgress(current, signal, { now: input.now, detail, progress });
    if (next) {
      result = current = next;
    }
  }
  return result;
}

/** Fold a batch of log lines in order; the last change wins. */
export function foldDeployProgressLogEntries(
  record: unknown,
  entries: Array<{ payload: unknown }>,
  input: { now: Date },
): DeployProgressRecord | undefined {
  let result: DeployProgressRecord | undefined;
  let current = record;
  for (const entry of entries) {
    const next = foldDeployProgressLog(current, entry.payload, input);
    if (next) {
      result = current = next;
    }
  }
  return result;
}

/** A command-queue row of this frame changed state (sent / acked / failed). */
export function foldDeployProgressCommand(
  record: unknown,
  type: string,
  state: string,
  input: { now: Date; error?: string | null },
): DeployProgressRecord | undefined {
  if (state !== "sent" && state !== "acked" && state !== "failed") {
    return undefined;
  }
  return foldDeployProgress(record, `command:${state}:${type}`, { now: input.now, detail: input.error ?? null });
}

/**
 * Whether a running record sat in its stage longer than the stage allows.
 * A `waiting` stage stays fresh while the frame's own wake forecast (plus
 * the contract's grace) is still ahead.
 */
export function deployProgressIsStale(
  record: unknown,
  now: Date,
  input: { nextWakeAt?: Date | null } = {},
): boolean {
  if (!isDeployProgressRecord(record) || record.status !== "running") {
    return false;
  }
  const at = Date.parse(record.at);
  if (!Number.isFinite(at)) {
    return true;
  }
  const spec = deployProgressContract.stages[record.stage as DeployProgressStage];
  if (!spec) {
    return true;
  }
  if (spec.freshWhileSleeping && input.nextWakeAt) {
    if (now.getTime() < input.nextWakeAt.getTime() + deployProgressContract.record.wakeGraceSeconds * 1000) {
      return false;
    }
  }
  return now.getTime() - at > spec.staleAfterSeconds * 1000;
}

/** 0..100 for a bar: the stage's position, the bytes fraction inside a download, 100 when done. */
export function deployProgressPercent(record: unknown): number {
  if (!isDeployProgressRecord(record)) {
    return 0;
  }
  if (record.status === "done") {
    return 100;
  }
  const names = kindStageNames(record.kind);
  const index = stageIndex(record.kind, record.stage);
  if (index < 0 || names.length === 0) {
    return 0;
  }
  let fraction = 0.3;
  const progress = record.progress;
  if (progress && typeof progress.current === "number" && typeof progress.total === "number" && progress.total > 0) {
    fraction = Math.max(0, Math.min(1, progress.current / progress.total));
  }
  return Math.round((100 * (index + fraction)) / names.length);
}
