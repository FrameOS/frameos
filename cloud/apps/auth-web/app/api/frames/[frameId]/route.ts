import { eq } from "drizzle-orm";
import { frames } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../src/lib/csrf";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import {
  frameForAccount,
  frameSummary,
  linkedClientForFrame,
  revokeFrame,
} from "../../../../src/lib/frames";
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

  // frameForAccount screens the uuid shape itself, so a malformed id lands in
  // the same "invisible, not forbidden" 404 as someone else's frame.
  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  return NextResponse.json({
    frame: {
      ...frameSummary(frame, await linkedClientForFrame(db, frame)),
      last_metrics: frame.lastMetrics,
      last_state: frame.lastState,
    },
  });
}

// Delete a frame outright — the shape the shared SPA already speaks
// (framesModel.deleteFrame → DELETE /api/frames/{id}). Revoke-then-delete:
// revocation kicks a live socket and invalidates the link token, so the
// device demotes itself to standalone and keeps rendering; the row delete
// then cascades away the frame's commands, logs, asset caches and scene
// assignments (claim tokens keep their history with frame_id set null).
// Unlike revoke, nothing of the frame remains in the workspace afterwards.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:delete", {
    limit: 60,
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

  // Already-revoked frames just need the row gone; revoking twice is
  // harmless but revokeFrame also NOTIFYs the hub, so skip the noise.
  if (frame.status !== "revoked") {
    await revokeFrame(db, frame);
  }
  await db.delete(frames).where(eq(frames.id, frame.id));
  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.deleted",
    metadata: { name: frame.name },
    target: { frameId: frame.id, linkedClientId: frame.linkedClientId },
  });
  return NextResponse.json({ status: "deleted" });
}
