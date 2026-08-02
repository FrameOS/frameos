import { and, asc, eq, gt } from "drizzle-orm";
import { frameLogs } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { frameForAccount } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

const maxLogsPerPage = 1000;

// Retained logs for a frame (?after_id= for incremental catch-up — the same
// contract the shared SPA's logsLogic speaks against the backend). Log rows
// are the device's shipped payloads; we surface them in LogType shape.
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

  const afterIdRaw = request.nextUrl.searchParams.get("after_id");
  const afterId = afterIdRaw ? Number.parseInt(afterIdRaw, 10) : undefined;

  const rows = await db
    .select()
    .from(frameLogs)
    .where(
      and(
        eq(frameLogs.frameId, frame.id),
        ...(afterId && Number.isFinite(afterId)
          ? [gt(frameLogs.id, afterId)]
          : []),
      ),
    )
    .orderBy(asc(frameLogs.id))
    .limit(maxLogsPerPage);

  return NextResponse.json({
    logs: rows.map((row) => {
      const payload =
        row.payload && typeof row.payload === "object"
          ? (row.payload as Record<string, unknown>)
          : {};
      return {
        frame_id: frame.id,
        id: row.id,
        line:
          typeof payload.line === "string"
            ? payload.line
            : JSON.stringify(row.payload),
        timestamp: row.timestamp,
        type:
          typeof payload.event === "string" ? payload.event : "log",
      };
    }),
  });
}
