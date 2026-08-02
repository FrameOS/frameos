import { asc, eq } from "drizzle-orm";
import { frames } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../src/lib/device-flow";
import { frameSummary } from "../../../src/lib/frames";
import { rateLimitResponse } from "../../../src/lib/rate-limit";
import { readSession } from "../../../src/lib/session";

export const runtime = "nodejs";

// List the account's frames. The shape matches what the shared SPA's
// framesModel expects from GET /api/frames ({"frames": [...]}).
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "frames:list", {
    limit: 240,
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

  const rows = await db
    .select()
    .from(frames)
    .where(eq(frames.accountId, session.accountId))
    .orderBy(asc(frames.createdAt));

  return NextResponse.json({
    frames: rows.map((frame) => ({
      ...frameSummary(frame),
      last_metrics: frame.lastMetrics,
      last_state: frame.lastState,
    })),
  });
}
