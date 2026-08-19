import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { frameForAccount, revokeFrame } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { requireRecentAuth } from "../../../../../src/lib/recent-auth";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// Revoke a frame: the linked client is revoked, so the device's next request
// or WS (re)connect gets 401 invalid_link_token and it demotes itself to
// standalone (it keeps rendering the last pushed scenes; see the wire
// contract). Re-enrolling needs a fresh claim token. Sensitive: the session
// must have proved its credentials recently (403 reauth_required otherwise).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:revoke", {
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
  const stale = await requireRecentAuth(db, session.accountId);
  if (stale) {
    return stale;
  }

  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }

  await revokeFrame(db, frame);
  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.revoked",
    target: { frameId: frame.id, linkedClientId: frame.linkedClientId },
  });
  return NextResponse.json({ status: "revoked" });
}
