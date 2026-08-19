import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "./audit";
import { csrfResponse } from "./csrf";
import { jsonError, requireDatabase } from "./device-flow";
import { enqueueFrameCommand, frameForAccount } from "./frames";
import { rateLimitResponse } from "./rate-limit";
import { readSession } from "./session";

// The canonical single-action routes (POST /api/frames/{id}/restart and
// /reboot) — the same paths the self-hosted backend serves, so the shared
// SPA does not need a cloud branch to power-cycle a frame
// (docs/api-triality.md). Each is a fixed-verb alias onto the durable
// command queue; the generic /command route stays for callers that speak
// the queue dialect directly.
//
// "Now"-commands expire fast, same as the command route: a reboot queued on
// Monday must not fire when the frame comes back online on Friday.
const actionCommandTtlMs = 5 * 60 * 1000;

export async function handleFrameActionCommand(
  request: NextRequest,
  params: Promise<{ frameId: string }>,
  type: "reboot" | "restart_runtime",
): Promise<NextResponse> {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  // Same budget as /command on purpose — these are the same actions under
  // canonical names, so alternating routes must not double the allowance.
  const limited = await rateLimitResponse(request, "frames:command", {
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
  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  if (frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }

  const command = await enqueueFrameCommand(db, {
    createdByAccountId: session.accountId,
    frameId: frame.id,
    ttlMs: actionCommandTtlMs,
    type,
  });

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.command_sent",
    metadata: { type },
    target: { commandId: command?.id, frameId: frame.id },
  });

  return NextResponse.json({ command_id: command?.id, status: "queued" });
}
