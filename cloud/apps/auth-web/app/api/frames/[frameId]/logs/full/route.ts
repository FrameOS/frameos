import { asc, eq } from "drizzle-orm";
import { frameLogs } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { frameForAccount } from "../../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";

export const runtime = "nodejs";

// "Download full log" in the shared SPA's Logs panel (logsLogic
// downloadFullLog → GET /api/frames/{id}/logs/full). The backend has served
// this since forever (backend/app/api/frames.py api_frame_download_full_logs);
// the cloud 404ing it made the menu item silently produce nothing. Same line
// format as the backend — `[iso-timestamp] (type) line` — so a downloaded log
// reads the same whichever control plane produced it. "Full" here is the
// cloud's whole retention window (maxLogsPerFrame rows, storage-capped), in
// one response: at 8 KB/line ceiling it stays well under fifty megabytes, and
// in practice a frame's window is a few megabytes.
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

  const rows = await db
    .select()
    .from(frameLogs)
    .where(eq(frameLogs.frameId, frame.id))
    .orderBy(asc(frameLogs.id));

  const lines = rows.map((row) => {
    const payload =
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : {};
    const line =
      typeof payload.line === "string"
        ? payload.line
        : JSON.stringify(row.payload);
    const type = typeof payload.event === "string" ? payload.event : "log";
    return `[${row.timestamp.toISOString()}] (${type}) ${line}`;
  });
  const content = lines.length > 0 ? lines.join("\n") + "\n" : "";

  const timestamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
  const filename = `frame-${frame.id}-full-logs-${timestamp}.log`;

  return new NextResponse(content, {
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
