import { and, desc, eq, gte } from "drizzle-orm";
import { frameMetrics } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  jsonError,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import {
  frameForAccount,
  maxMetricsPerFrame,
} from "../../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";
import { metricsRow } from "../shape";

export const runtime = "nodejs";

// Incremental catch-up (?since=<timestamp>) — the contract the shared SPA's
// metricsLogic speaks on websocket reconnect, matching the backend's
// /metrics/recent: samples with timestamp >= since, newest maxMetricsPerFrame
// of them, chronological. Inclusive on purpose; the SPA dedupes on timestamp.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:metrics", {
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

  const sinceRaw = request.nextUrl.searchParams.get("since");
  const sinceMs = sinceRaw === null ? Number.NaN : Date.parse(sinceRaw);
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs) : undefined;

  // Newest first so the limit keeps the most recent samples, then reversed
  // into chronological order — the backend's exact recipe.
  const rows = await db
    .select()
    .from(frameMetrics)
    .where(
      and(
        eq(frameMetrics.frameId, frame.id),
        ...(since === undefined ? [] : [gte(frameMetrics.timestamp, since)]),
      ),
    )
    .orderBy(desc(frameMetrics.id))
    .limit(maxMetricsPerFrame);
  rows.reverse();

  return NextResponse.json({
    metrics: rows.map((row) => metricsRow(frame.id, row)),
  });
}
