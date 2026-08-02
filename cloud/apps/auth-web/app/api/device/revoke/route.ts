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
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
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

  await db
    .update(linkedClients)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(linkedClients.id, linkedClient.id));

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "linked_client.revoked",
    target: { linkedClientId: linkedClient.id },
  });

  return NextResponse.json({ status: "revoked" });
}
