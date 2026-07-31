import { headers } from "next/headers";
import {
  type createDb,
  recordAuditEvent as recordAuditEventRow,
} from "@frameos-cloud/db";
import { clientIpFromHeaders } from "./rate-limit";

// Drop-in replacement for the db package's recordAuditEvent that stamps the
// caller's IP (per the trusted-proxy config) into the actor, so the activity
// feed can show where an action came from. Falls back to recording without
// an IP outside a request scope.
export async function recordAuditEvent(
  db: ReturnType<typeof createDb>,
  event: {
    accountId?: string | undefined;
    actor: unknown;
    eventType: string;
    metadata?: unknown;
    target?: unknown;
  },
) {
  let ip: string | undefined;
  try {
    ip = clientIpFromHeaders(await headers());
  } catch {
    // Not in a request scope; record without an IP.
  }
  const actor =
    event.actor && typeof event.actor === "object"
      ? (event.actor as Record<string, unknown>)
      : {};
  await recordAuditEventRow(db, {
    ...event,
    actor: ip ? { ...actor, ip } : event.actor,
  });
}
