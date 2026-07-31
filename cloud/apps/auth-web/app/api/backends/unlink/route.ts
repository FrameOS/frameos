import { eq } from "drizzle-orm";
import { linkedClients } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { authenticateLinkedClient } from "../../../../src/lib/backend-auth";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// Bearer-authenticated self-unlink for a backend that wants to disconnect
// itself. The session-authenticated, user-facing counterpart is
// /api/device/revoke.
export async function POST(request: NextRequest) {
  const limited = rateLimitResponse(request, "backend:unlink", {
    limit: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  // authenticateLinkedClient only matches unrevoked clients, so a repeated
  // unlink with the same token fails here with 401 instead of re-revoking.
  const linkedClient = await authenticateLinkedClient(
    db,
    request.headers.get("authorization"),
  );
  if (!linkedClient) {
    return jsonError("invalid_link_token", 401);
  }

  await db
    .update(linkedClients)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(linkedClients.id, linkedClient.id));

  await recordAuditEvent(db, {
    accountId: linkedClient.accountId,
    actor: { linkedClientId: linkedClient.id },
    eventType: "linked_client.unlinked",
    target: { linkedClientId: linkedClient.id },
  });

  return NextResponse.json({ status: "unlinked" });
}
