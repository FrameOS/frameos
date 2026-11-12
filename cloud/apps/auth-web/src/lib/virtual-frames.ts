// Virtual frames (docs/cloud-frames.md "Virtual frames"): a frame with no
// hardware. The frame hub runs its device half and renders its scenes with
// the wasm runtime (apps/frame-hub/src/virtual-device.ts); the picture is
// served through a view link. This file is what both processes share: the
// shape of the row, the rules for its size and its link, and the scene
// refresh rule. Free of Next imports on purpose, like frames.ts.
//
// A virtual frame is the paid entitlement of cloud/docs/accounting-todo.md
// §0.2 (`cloud_rendered_frames`): N frames and a refresh floor, none on the
// free plan. Creating one is virtual-frame-create.ts.

import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { virtualFrames, type createDb } from "@frameos-cloud/db";
import { maxRenderDimension, maxRenderPixels, minRenderDimension } from "./scene-render";

type Database = ReturnType<typeof createDb>;
type DatabaseOrTransaction = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** `hardware.platform` of a virtual frame, as on the self-hosted backend. */
export const virtualPlatform = "virtual";

export const virtualFrameMinDimension = minRenderDimension;
export const virtualFrameMaxDimension = maxRenderDimension;
export const virtualFrameMaxPixels = maxRenderPixels;
export const virtualFrameDefaultWidth = 800;
export const virtualFrameDefaultHeight = 480;

// NOTIFY channel for "a virtual frame was created, or its row changed in a
// way its device should hear without a command" (payload: the frame id). The
// hub also reconciles on a timer, so a missed notify costs seconds.
export const virtualFramesNotifyChannel = "frameos_virtual_frames";

// How long after the last look a virtual frame still renders on its
// interval. A page that shows the picture asks again well inside this.
export const virtualFrameWatchWindowMs = 3 * 60 * 1000;
// The view link stamps viewed_at at most this often.
export const virtualFrameViewStampMs = 30 * 1000;
// What a frame renders at when neither its scene nor its settings say.
export const virtualFrameDefaultIntervalSeconds = 300;

export const virtualViewTokenPrefix = "vf_";
const viewTokenPattern = /^vf_[A-Za-z0-9_-]{32,64}$/;

export function newVirtualViewToken(): string {
  return `${virtualViewTokenPrefix}${randomBytes(24).toString("base64url")}`;
}

export function isVirtualViewToken(value: unknown): value is string {
  return typeof value === "string" && viewTokenPattern.test(value);
}

/**
 * What the frame's `hardware` says about being virtual. A display hint and a
 * quota class only: a device reports its own hardware, so what makes a frame
 * virtual is its virtual_frames row, never this.
 */
export function hardwareIsVirtual(hardware: unknown): boolean {
  return (
    !!hardware &&
    typeof hardware === "object" &&
    !Array.isArray(hardware) &&
    (hardware as { platform?: unknown }).platform === virtualPlatform
  );
}

export function virtualSizeError(width: unknown, height: unknown): string | undefined {
  for (const value of [width, height]) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < virtualFrameMinDimension ||
      value > virtualFrameMaxDimension
    ) {
      return "invalid_size";
    }
  }
  if ((width as number) * (height as number) > virtualFrameMaxPixels) {
    return "size_too_large";
  }
  return undefined;
}

/** The hardware report a virtual frame's device sends, at this size. */
export function virtualHardware(width: number, height: number): Record<string, unknown> {
  return {
    device: virtualPlatform,
    eventMap: [],
    gpioButtons: [],
    height,
    platform: virtualPlatform,
    width,
  };
}

export function virtualFrameSize(hardware: unknown): { height: number; width: number } {
  const record =
    hardware && typeof hardware === "object" && !Array.isArray(hardware)
      ? (hardware as Record<string, unknown>)
      : {};
  const width = record.width;
  const height = record.height;
  return virtualSizeError(width, height)
    ? { height: virtualFrameDefaultHeight, width: virtualFrameDefaultWidth }
    : { height: height as number, width: width as number };
}

export function virtualViewPath(token: string): string {
  return `/v/${token}`;
}

export function virtualImagePath(token: string): string {
  return `/v/${token}/image`;
}

export async function virtualFrameRow(db: DatabaseOrTransaction, frameId: string) {
  const [row] = await db
    .select()
    .from(virtualFrames)
    .where(eq(virtualFrames.frameId, frameId))
    .limit(1);
  return row;
}

export async function notifyVirtualFrame(db: DatabaseOrTransaction, frameId: string) {
  await db.execute(sql`select pg_notify(${virtualFramesNotifyChannel}, ${frameId})`);
}

// --- The scene's refresh interval --------------------------------------------
//
// The rule every runtime follows (backend/app/utils/refresh_interval.py,
// frameos/src/frameos/refresh_interval.nim, frontend/src/utils/
// refreshInterval.ts): a field with role "refreshInterval", else a numeric
// field named refreshInterval, else the scene's settings.refreshInterval as
// an implicit state key of that name. A refreshInterval field of another
// type is the scene's own business, and the settings alone decide.

function positiveSeconds(value: unknown): number {
  if (typeof value === "boolean" || value === null || value === undefined) {
    return 0;
  }
  const seconds = typeof value === "string" ? Number(value.trim()) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Seconds between renders the scene asks for, or null when it has no say. */
export function sceneRefreshSeconds(scene: unknown, state: unknown): number | null {
  const sceneRecord = recordOf(scene);
  const stateRecord = recordOf(state);
  const fields = (Array.isArray(sceneRecord.fields) ? sceneRecord.fields : []).map(recordOf);
  const fromSettings = positiveSeconds(recordOf(sceneRecord.settings).refreshInterval);
  const declared =
    fields.find((field) => field.role === "refreshInterval") ??
    fields.find(
      (field) => field.name === "refreshInterval" && (field.type === "float" || field.type === "integer"),
    );
  let seconds: number;
  if (declared) {
    const key = typeof declared.name === "string" ? declared.name : "";
    seconds = positiveSeconds(key ? stateRecord[key] : undefined) || positiveSeconds(declared.value) || fromSettings;
  } else if (fields.some((field) => field.name === "refreshInterval")) {
    seconds = fromSettings;
  } else {
    seconds = positiveSeconds(stateRecord.refreshInterval) || fromSettings;
  }
  return seconds > 0 ? seconds : null;
}

/**
 * How often a virtual frame renders while someone looks: its scene's
 * interval, else the frame's, never under the plan's floor.
 */
export function virtualRenderIntervalSeconds(input: {
  frameIntervalSeconds: unknown;
  minIntervalSeconds: number;
  sceneRefreshSeconds: number | null | undefined;
}): number {
  const wanted =
    positiveSeconds(input.sceneRefreshSeconds) ||
    positiveSeconds(input.frameIntervalSeconds) ||
    virtualFrameDefaultIntervalSeconds;
  return Math.max(input.minIntervalSeconds, wanted);
}

// --- Scene state between renders -----------------------------------------------

function sceneFieldRecords(scene: unknown): Record<string, unknown>[] {
  const fields = recordOf(scene).fields;
  return (Array.isArray(fields) ? fields : []).map(recordOf).filter((field) => typeof field.name === "string");
}

/**
 * The part of a `state` payload a scene takes from outside: its public
 * fields (no `access`, or anything but "private") and its refresh interval,
 * as every runtime filters a setSceneState. A json field sent as text is
 * parsed, as the device does.
 */
export function publicSceneState(scene: unknown, state: unknown): Record<string, unknown> {
  const fields = sceneFieldRecords(scene);
  const types = new Map(fields.map((field) => [field.name as string, field.type]));
  const settable = new Set(
    fields.filter((field) => field.access !== "private").map((field) => field.name as string),
  );
  if (!types.has("refreshInterval")) {
    settable.add("refreshInterval");
  }
  const accepted: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(recordOf(state))) {
    if (!settable.has(key)) {
      continue;
    }
    let value = raw;
    if (types.get(key) === "json" && typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        // kept as the text it came as
      }
    }
    accepted[key] = value;
  }
  return accepted;
}

/**
 * What of a render's reported state is kept for the next one: the public
 * fields and those the scene marks `persist: "disk"`, the device's own
 * across-restarts contract.
 */
export function storableSceneState(scene: unknown, state: unknown): Record<string, unknown> {
  const fields = sceneFieldRecords(scene);
  const keep = new Set(
    fields
      .filter((field) => field.access !== "private" || field.persist === "disk")
      .map((field) => field.name as string),
  );
  if (!fields.some((field) => field.name === "refreshInterval")) {
    keep.add("refreshInterval");
  }
  return Object.fromEntries(Object.entries(recordOf(state)).filter(([key]) => keep.has(key)));
}
