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
    entries.push({
      payload: entry.payload ?? null,
      timestamp: parseLogTimestamp(entry.timestamp),
    });
  }
  return entries;
}

// Browser event envelope, matching what frontend/src/scenes/socketLogic.tsx
// dispatches: {"event": "<name>", "data": {...}}.
export function browserEvent(event: string, data: unknown) {
  return JSON.stringify({ data, event });
}

// new_log event in the shape the SPA's Logs panel expects. frame_id is the
// frame's uuid — the same id the frames API returns, so
// `log.frame_id === props.frameId` holds in the SPA.
export function newLogEvent(
  frameId: string,
  row: { id: number; timestamp: Date; payload: unknown },
) {
  const payload = isRecord(row.payload) ? row.payload : {};
  return {
    frame_id: frameId,
    id: row.id,
    line:
      typeof payload.line === "string"
        ? payload.line
        : JSON.stringify(row.payload ?? null),
    timestamp: row.timestamp.toISOString(),
    type: typeof payload.event === "string" ? payload.event : "log",
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
