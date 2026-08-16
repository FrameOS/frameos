import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import {
  frameForAccount,
  listPendingFrameCommands,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// What is still waiting for this frame to wake up.
//
// A cloud frame's actions are queued, not applied: reboot, render, a scene
// push and a firmware notification all land in frame_commands and sit there
// until the device connects (docs/cloud-frames.md, "Command queue"). On a
// battery ESP32 that sleeps for hours, "queued" and "done" looked identical
// in the workspace — the deploy drawer said the push was sent and nothing
// ever said it had not arrived yet. This is the read side of that; DELETE on
// /commands/{id} is the way back out.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:commands", {
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

  const commands = await listPendingFrameCommands(db, frame.id);
  return NextResponse.json(
    { commands },
    { headers: { "cache-control": "no-store" } },
  );
}
