import { asc, eq } from "drizzle-orm";
import { frameMetrics } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { frameForAccount, maxMetricsPerFrame } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";
import { metricsRow } from "./shape";

export const runtime = "nodejs";

// Retained metrics history for a frame, in the shape the shared SPA's
// metricsLogic loads on mount ({metrics: MetricsType[]}, reboots optional —
// the panel also derives reboot markers from the samples and live log lines).
// Retention is capped at maxMetricsPerFrame on insert (storeFrameMetrics), so
// serving the whole window is bounded.
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

  // id order is insert order, and timestamps are assigned by the hub on
  // insert, so this is chronological — what the panel expects.
  const rows = await db
    .select()
    .from(frameMetrics)
    .where(eq(frameMetrics.frameId, frame.id))
    .orderBy(asc(frameMetrics.id))
    .limit(maxMetricsPerFrame);

  return NextResponse.json({
    metrics: rows.map((row) => metricsRow(frame.id, row)),
  });
}
