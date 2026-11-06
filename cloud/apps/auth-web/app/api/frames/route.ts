import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../src/lib/device-flow";
import { frameSummary, pendingCommandTypesByFrame, scenePreviewsByFrame } from "../../../src/lib/frames";
import { frameAccessSummary, framesForAccount } from "../../../src/lib/organizations";
import { rateLimitResponse } from "../../../src/lib/rate-limit";
import { readSession } from "../../../src/lib/session";

export const runtime = "nodejs";

// List the account's frames: its own, then the ones shared with it through a
// project (cloud/docs/sharing.md). Each carries `access`: who the account is
// to the frame and the project it is shared through. The shape matches what
// the shared SPA's framesModel expects from GET /api/frames ({"frames": [...]}).
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
  // receives the account's service settings.
  const rows = await framesForAccount(db, session.accountId);

  const frameIds = rows.map(({ frame }) => frame.id);
  const [pendingTypes, previews] = await Promise.all([
    pendingCommandTypesByFrame(db, frameIds),
    scenePreviewsByFrame(db, frameIds),
  ]);
  return NextResponse.json({
    frames: rows.map(({ access, frame, linkedClient }) => ({
      ...frameSummary(frame, linkedClient ?? undefined),
      access: frameAccessSummary(access),
      last_metrics: frame.lastMetrics,
      last_state: frame.lastState,
      pending_command_types: pendingTypes.get(frame.id) ?? [],
      scene_preview: previews.get(frame.id) ?? null,
    })),
  });
}
