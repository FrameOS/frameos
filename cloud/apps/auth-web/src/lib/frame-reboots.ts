// Reboot markers for the Metrics panel, derived from a cloud-managed frame's
// shipped logs — the cloud half of the backend's _frame_reboot_markers
// (backend/app/api/frames.py). The SPA's metricsLogic draws one vertical rule
// per marker and reads them from the `reboots` array of /metrics and
// /metrics/recent; without it a cloud frame's chart showed a gap where a
// restart happened and nothing to say a restart was the reason.
//
// The source is the device's own `{"event": "bootup"}` log line. The Linux
// runtime attaches a `reboot` object to it (frameos.nim → startupRebootInfo:
// boot ids, systemd service result, OOM/watchdog kind); the ESP32 sends the
// bare bootup line, which still marks the boot itself.
//
// What is deliberately NOT ported: the backend also guesses a reason from the
// shell output preceding a boot ("sudo reboot", an OOM killer line, a failed
// reload). Those lines exist because the backend drives the device over SSH.
// The cloud has no shell verbs at all (docs/api-triality.md), so there is
// nothing to scan — a cloud marker carries what the device reported and
// nothing inferred.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { createDb, frameLogs } from "@frameos-cloud/db";

// Every field the SPA's parseRebootMarker reads, snake_cased on the wire like
// the backend's. Values are stringified there, so strings are enough here.
export interface RebootMarker {
  timestamp: string;
  log_id?: string;
  boot_id?: string;
  previous_boot_id?: string;
  kind?: string;
  reason?: string;
  source?: string;
  message?: string;
  error?: string;
  service_result?: string;
  exit_code?: string;
  exit_status?: string;
}

// Device spelling → wire spelling. Both cases are accepted for the same
// reason the backend accepts both: the payload is written by the runtime in
// camelCase and by older/hand-rolled senders in snake_case.
const rebootFields: [keyof RebootMarker, string[]][] = [
  ["boot_id", ["bootId", "boot_id"]],
  ["previous_boot_id", ["previousBootId", "previous_boot_id"]],
  ["kind", ["kind"]],
  ["reason", ["reason"]],
  ["source", ["source"]],
  ["message", ["message"]],
  ["error", ["error"]],
  ["service_result", ["serviceResult", "service_result"]],
  ["exit_code", ["exitCode", "exit_code"]],
  ["exit_status", ["exitStatus", "exit_status"]],
];

// The backend's _reboot_kind_from_service_result: a systemd result is the
// most reliable statement about WHY the last run ended, so it names the kind
// when the device did not.
function kindFromServiceResult(serviceResult: string | undefined) {
  switch (serviceResult) {
    case undefined:
    case "":
      return undefined;
    case "oom-kill":
      return "oom";
    case "watchdog":
      return "watchdog";
    case "success":
      return "initiated";
    default:
      return "error";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// One log row → one marker, or undefined when the row is not a bootup line.
export function rebootMarkerFromLog(row: {
  id: number;
  payload: unknown;
  timestamp: Date;
}): RebootMarker | undefined {
  if (!isRecord(row.payload) || row.payload.event !== "bootup") {
    return undefined;
  }
  const marker: RebootMarker = {
    log_id: String(row.id),
    timestamp: row.timestamp.toISOString(),
  };
  const reboot = row.payload.reboot;
  if (isRecord(reboot)) {
    for (const [field, keys] of rebootFields) {
      for (const key of keys) {
        const value = reboot[key];
        if (value !== undefined && value !== null && value !== "") {
          marker[field] = String(value);
          break;
        }
      }
    }
  }
  if (!marker.kind) {
    const kind = kindFromServiceResult(marker.service_result);
    if (kind) {
      marker.kind = kind;
    }
  }
  return marker;
}

// A frame's reboot markers, oldest first — the order the panel's dedupe
// expects. Bounded twice: log retention caps the table per frame
// (maxLogsPerFrame), and the newest `limit` boot lines are all a chart can
// show anyway.
export async function frameRebootMarkers(
  db: ReturnType<typeof createDb>,
  frameId: string,
  options: { limit?: number; since?: Date } = {},
): Promise<RebootMarker[]> {
  const limit = options.limit ?? 500;
  const rows = await db
    .select({
      id: frameLogs.id,
      payload: frameLogs.payload,
      timestamp: frameLogs.timestamp,
    })
    .from(frameLogs)
    .where(
      and(
        eq(frameLogs.frameId, frameId),
        // Filtered in Postgres: a chatty frame's 5000 retained lines hold a
        // handful of boots, and shipping the rest here to drop them would be
        // the expensive way to get the same answer.
        sql`${frameLogs.payload}->>'event' = 'bootup'`,
        ...(options.since === undefined
          ? []
          : [gte(frameLogs.timestamp, options.since)]),
      ),
    )
    .orderBy(desc(frameLogs.id))
    .limit(limit);
  rows.reverse();
  return rows.flatMap((row) => {
    const marker = rebootMarkerFromLog(row);
    return marker ? [marker] : [];
  });
}
