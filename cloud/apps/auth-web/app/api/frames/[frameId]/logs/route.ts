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
  const parsedAfterId =
    afterIdRaw === null ? Number.NaN : Number.parseInt(afterIdRaw, 10);
  // after_id=0 is a real cursor ("everything from the beginning"), not an
  // absent one — id is a generated identity starting at 1, so a truthiness
  // check would silently drop the filter.
  const afterId =
    Number.isFinite(parsedAfterId) && parsedAfterId >= 0
      ? parsedAfterId
      : undefined;

  // One row over the page so the caller can tell a full page from a
  // truncated one and knows to fetch again with after_id.
  const rows = await db
    .select()
    .from(frameLogs)
    .where(
      and(
        eq(frameLogs.frameId, frame.id),
        ...(afterId === undefined ? [] : [gt(frameLogs.id, afterId)]),
      ),
    )
    .orderBy(asc(frameLogs.id))
    .limit(maxLogsPerPage + 1);
  const hasMore = rows.length > maxLogsPerPage;
  const page = hasMore ? rows.slice(0, maxLogsPerPage) : rows;

  return NextResponse.json({
    has_more: hasMore,
    logs: page.map((row) => {
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
