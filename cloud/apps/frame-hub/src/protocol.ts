// Pure message-shaping helpers for the frame hub. Wire contract:
// docs/cloud-frames.md at the repo root ("The management WebSocket").
// Shared pure helpers are imported straight from apps/auth-web source — that
// file is deliberately free of Next imports so the hub can share it (see the
// header comment in cloud/apps/auth-web/src/lib/frames.ts).
import type { frames } from "@frameos-cloud/db";
import { linkedClientScopes } from "../../auth-web/src/lib/backend-auth";
import { frameManagedScope, frameSummary } from "../../auth-web/src/lib/frames";

export type FrameRow = typeof frames.$inferSelect;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonMessage(
  data: unknown,
): Record<string, unknown> | undefined {
  try {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data as Buffer[]).toString("utf8")
            : undefined;
    if (text === undefined) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Provider → frame command frame: {"id": <command uuid>, "type": ..., …payload}.
// id/type come last so a malformed payload can never override them.
export function commandMessage(command: {
  id: string;
  type: string;
  payload: unknown;
}): Record<string, unknown> {
  const payload = isRecord(command.payload) ? command.payload : {};
  return { ...payload, id: command.id, type: command.type };
}

// Was the device socket allowed in? Mirrors the checks the auth-web HTTP
// routes make: a live linked client of kind "frame" holding frame:managed.
export function deviceAuthError(
  linkedClient:
    | { clientKind: string; providerClientMetadata: unknown }
    | undefined,
  frame: FrameRow | undefined,
): string | undefined {
  if (!linkedClient) {
    return "invalid_link_token";
  }
  if (linkedClient.clientKind !== "frame") {
    return "not_a_frame";
  }
  if (!linkedClientScopes(linkedClient).includes(frameManagedScope)) {
    return "insufficient_scope";
  }
  if (!frame) {
    return "frame_not_enrolled";
  }
  if (frame.status === "revoked") {
    return "frame_revoked";
  }
  return undefined;
}

// Device log timestamps may arrive as epoch seconds, epoch milliseconds, or
// an ISO string; anything unparseable falls back to "now".
export function parseLogTimestamp(value: unknown, fallback = new Date()): Date {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value >= 1e12 ? value : value * 1000);
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}

// Longest scene id the hub stores, matching the ceiling auth-web puts on a
// set_current_scene payload. Applies to a log entry's `scene` and to the
// active_scene a scene_ack merges into last_state.
export const maxSceneIdChars = 256;

export function parseLogEntries(
  value: unknown,
): { timestamp: Date; payload: unknown }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: { timestamp: Date; payload: unknown }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    // The wire contract allows an optional per-entry `scene`
    // (docs/cloud-frames.md, "log_batch"). frame_logs has no scene column, so
    // it is folded into the stored jsonb payload instead of being dropped —
    // an explicit payload.scene from the device still wins, and a non-object
    // payload is wrapped rather than losing either half.
    let payload = entry.payload ?? null;
    if (typeof entry.scene === "string") {
      const scene = entry.scene.slice(0, maxSceneIdChars);
      payload = isRecord(payload) ? { scene, ...payload } : { payload, scene };
    }
    entries.push({ payload, timestamp: parseLogTimestamp(entry.timestamp) });
  }
  return entries;
}

// Size caps for device-supplied values the hub persists. Everything a device
// sends is untrusted (cloud/docs/cloud-frames.md, threat model): without a cap
// one oversized `state` writes a huge jsonb row that every later
// broadcastFrameUpdate re-selects and fans out to every browser socket on the
// account.
//
// Oversized values are rejected, never truncated: a half-serialized jsonb blob
// is not valid state, and a truncated checksum would compare unequal to the
// assigned one forever (the UI would show a permanently out-of-sync frame with
// no way to recover). Rejecting leaves the last good value in place, which is
// both accurate and self-healing on the next well-formed message.
export const maxStateBytes = 64 * 1024;
export const maxMetricsBytes = 16 * 1024;
export const maxChecksumChars = 128;

export function jsonByteLength(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function withinJsonByteLimit(value: unknown, maxBytes: number) {
  return jsonByteLength(value) <= maxBytes;
}

// A checksum is a hex digest; anything longer than maxChecksumChars is not one.
export function isAcceptableChecksum(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxChecksumChars;
}

// Browser event envelope, matching what frontend/src/scenes/socketLogic.tsx
// dispatches: {"event": "<name>", "data": {...}}.
export function browserEvent(event: string, data: unknown) {
  return JSON.stringify({ data, event });
}

// new_log event in the shape the SPA's Logs panel expects. frame_id is the
// frame's uuid — the same id the frames API returns, so
// `log.frame_id === props.frameId` holds in the SPA.
//
// Structured payloads ship as type "webhook" with the whole object as the
// line — the exact shape the self-hosted backend stores device logs in
// (backend/app/models/log.py process_log), which is what the SPA's Logs
// panel pretty-renders (event highlighted, the rest as key=value) instead
// of a wall of raw JSON. Non-object payloads stay plain "log" lines.
export function newLogEvent(
  frameId: string,
  row: { id: number; timestamp: Date; payload: unknown },
) {
  const structured = isRecord(row.payload);
  return {
    frame_id: frameId,
    id: row.id,
    line: JSON.stringify(row.payload ?? null),
    timestamp: row.timestamp.toISOString(),
    type: structured ? "webhook" : "log",
  };
}

// new_metrics event in the MetricsType shape the SPA's Metrics panel expects
// (frontend/src/types.tsx) — the same row the /metrics and /metrics/recent
// routes serve, so a live sample and its later refetch dedupe cleanly on
// timestamp. id is stringified to match the backend's uuid-string ids; a
// sample that was not retained (store failure) is broadcast without one.
export function newMetricsEvent(
  frameId: string,
  row: { id: number | null; timestamp: Date; metrics: unknown },
) {
  return {
    frame_id: frameId,
    ...(row.id === null ? {} : { id: String(row.id) }),
    metrics: row.metrics,
    timestamp: row.timestamp.toISOString(),
  };
}

// update_frame event data: the summary the frames API serves, extended with
// the live state the hub owns.
export function frameUpdateEvent(frame: FrameRow) {
  return {
    ...frameSummary(frame),
    last_metrics: frame.lastMetrics,
    last_state: frame.lastState,
  };
}

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
