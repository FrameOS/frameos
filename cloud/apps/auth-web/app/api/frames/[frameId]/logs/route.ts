import { and, asc, desc, eq, gt, gte, sql } from "drizzle-orm";
import { frameLogs } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { logSearchPattern, parseFrameLogQuery } from "../../../../../src/lib/frame-log-query";
import { frameForAccount, requestDeviceLogRingIfEmpty } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// Retained logs for a frame (?after_id= for incremental catch-up — the same
// contract the shared SPA's logsLogic speaks against the backend). Log rows
// are the device's shipped payloads; we surface them in LogType shape.
// ?limit= (1..1000), ?search= (substring of the stored payload, case-
// insensitive) and ?since= (ISO instant) narrow the page in the database,
// so a caller after "the last five errors" does not pull the whole window
// (src/lib/frame-log-query.ts).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:logs", {
    limit: 600,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }

  const { afterId, limit, search, since } = parseFrameLogQuery(
    request.nextUrl.searchParams,
  );

  // Opening the panel (no cursor) on a frame the cloud holds no logs for
  // asks the device for its on-device ring — the lines a frame enrolled
  // before its telemetry grant kept to itself (get_logs, docs/cloud-frames.md).
  if (afterId === undefined) {
    await requestDeviceLogRingIfEmpty(db, frame);
  }

  // One row over the page so the caller can tell a full page from a
  // truncated one and knows to fetch again with after_id.
  //
  // Direction matters: with a cursor this walks FORWARD (oldest first after
  // the cursor — incremental catch-up). Without one it must page from the
  // NEWEST end, like the backend (frames.py api_frame_get_logs: newest 1000,
  // then reversed) — ascending from the top of a 5000-row retention window
  // opened the panel on the oldest, stalest logs a chatty frame had.
  const rows = await db
    .select()
    .from(frameLogs)
    .where(
      and(
        eq(frameLogs.frameId, frame.id),
        ...(afterId === undefined ? [] : [gt(frameLogs.id, afterId)]),
        ...(since === undefined ? [] : [gte(frameLogs.timestamp, since)]),
        // The payload is jsonb; its text form is what the SPA shows as the
        // line, so that is what the substring is matched against.
        ...(search === undefined
          ? []
          : [sql`${frameLogs.payload}::text ILIKE ${logSearchPattern(search)}`]),
      ),
    )
    .orderBy(afterId === undefined ? desc(frameLogs.id) : asc(frameLogs.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  if (afterId === undefined) {
    // Chronological for display; the query fetched newest-first.
    page.reverse();
  }

  return NextResponse.json({
    has_more: hasMore,
    logs: page.map((row) => {
      // Same mapping as the hub's newLogEvent: structured payloads ship as
      // type "webhook" with the whole object as the line — the shape the
      // self-hosted backend stores device logs in, which the SPA's Logs
      // panel pretty-renders (event highlighted, the rest as key=value).
      const structured =
        Boolean(row.payload) &&
        typeof row.payload === "object" &&
        !Array.isArray(row.payload);
      return {
        frame_id: frame.id,
        id: row.id,
        line: JSON.stringify(row.payload ?? null),
        timestamp: row.timestamp,
        type: structured ? "webhook" : "log",
      };
    }),
  });
}
