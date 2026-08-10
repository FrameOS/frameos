import { asc, eq } from "drizzle-orm";
import { frames, linkedClients } from "@frameos-cloud/db";
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

  // The link rides along so the summary can report whether the frame still
  // receives the account's service settings; a LEFT join keeps a frame whose
  // linked client vanished visible (it just cannot answer that question).
  const rows = await db
    .select({ frame: frames, linkedClient: linkedClients })
    .from(frames)
    .leftJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
    .where(eq(frames.accountId, session.accountId))
    .orderBy(asc(frames.createdAt));

  return NextResponse.json({
    frames: rows.map(({ frame, linkedClient }) => ({
      ...frameSummary(frame, linkedClient ?? undefined),
      last_metrics: frame.lastMetrics,
      last_state: frame.lastState,
    })),
  });
}
