import { and, eq, isNull } from "drizzle-orm";
import { linkedClients } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { revokeLinkedClient } from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { requireRecentAuth } from "../../../../src/lib/recent-auth";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = await rateLimitResponse(request, "device:revoke", {
    limit: 30,
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
  // Revoking a link is sensitive: the session must have proved its
  // credentials recently (403 reauth_required otherwise).
  const stale = await requireRecentAuth(db, session.accountId);
  if (stale) {
    return stale;
  }

  const body = await readJsonObject(request);
  const linkedClientId =
    typeof body.linked_client_id === "string" ? body.linked_client_id : "";
  if (!linkedClientId) {
    return jsonError("invalid_linked_client", 400);
  }

  const [linkedClient] = await db
    .select({ id: linkedClients.id })
    .from(linkedClients)
    .where(
      and(
        eq(linkedClients.id, linkedClientId),
        eq(linkedClients.accountId, session.accountId),
        isNull(linkedClients.revokedAt),
      ),
    )
    .limit(1);

  if (!linkedClient) {
    return jsonError("invalid_linked_client", 404);
  }

  // A frame's link is the frame's credential: revoking it here must leave
  // the frame row revoked (queue expired, live socket kicked), exactly as
  // the frame's own revoke route does.
  const frame = await revokeLinkedClient(db, linkedClient.id);

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "linked_client.revoked",
    target: { linkedClientId: linkedClient.id, ...(frame ? { frameId: frame.id } : {}) },
  });

  return NextResponse.json({ status: "revoked" });
}
