import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { frameForAccount, frameStatesRecord } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// Per-scene public state, the same {sceneId, states, cache} the self-hosted
// backend's /states answers (backend/app/api/frames.py), so the shared SPA's
// control drawer needs no cloud branch. The states are the device's own
// report (hello / `state`, mirrored onto frames.last_state by the hub); a
// connected frame is asked to refresh it with the `get_state` verb, deduped
// on the queue, and `cache.refreshing` tells the drawer to sync again.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:states", {
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
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  return NextResponse.json(await frameStatesRecord(db, frame), {
    headers: { "cache-control": "no-store" },
  });
}
