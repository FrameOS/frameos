import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import {
  jsonError,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import {
  cancelFrameCommand,
  frameForAccount,
  isFrameId,
} from "../../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";

export const runtime = "nodejs";

// Take a queued command back off the queue (see the GET beside this file).
//
// Only ever "not delivered yet": once the device has the command it has the
// command, and the queue cannot recall it. That is honest — the workspace
// says "waiting", and cancelling is what you can do while it still is.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string; commandId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:command-cancel", {
    limit: 120,
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

  const { commandId, frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  // Command ids are uuids and arrive as a raw path segment; Postgres answers
  // anything else with a 500-shaped cast error, so screen the shape first.
  if (!isFrameId(commandId)) {
    return jsonError("invalid_command", 404);
  }

  // Already delivered, already expired, or already cancelled by another tab:
  // all "there is nothing here to cancel", and all a 404 rather than a
  // pretend success that would leave the panel claiming it stopped something.
  if (!(await cancelFrameCommand(db, frame.id, commandId))) {
    return jsonError("command_not_pending", 404);
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.command_cancelled",
    target: { commandId, frameId: frame.id },
  });

  return NextResponse.json({ status: "cancelled" });
}
