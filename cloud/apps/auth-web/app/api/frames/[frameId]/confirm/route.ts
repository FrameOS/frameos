import { eq } from "drizzle-orm";
import { frames } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { frameForAccount, frameSummary } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// Owner confirmation of a claim-token enrollment: pending → active. This is
// the deliberate click that authorizes managing the physical device; no
// scene push is accepted before it.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:confirm", {
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
  if (frame.status === "revoked") {
    return jsonError("frame_revoked", 409);
  }
  if (frame.status !== "active") {
    await db
      .update(frames)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(frames.id, frame.id));
    await recordAuditEvent(db, {
      accountId: session.accountId,
      actor: {
        accountId: session.accountId,
        providerSubject: session.providerSubject,
      },
      eventType: "frame.confirmed",
      target: { frameId: frame.id },
    });
  }
  return NextResponse.json({
    frame: { ...frameSummary(frame), status: "active" },
    status: "active",
  });
}
