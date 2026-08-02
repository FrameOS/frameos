import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import { frameForAccount, frameSummary } from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:detail", {
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

  const { frameId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(frameId)) {
    return jsonError("invalid_frame", 400);
  }
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  return NextResponse.json({
    frame: {
      ...frameSummary(frame),
      last_metrics: frame.lastMetrics,
      last_state: frame.lastState,
    },
  });
}
