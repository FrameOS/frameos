import { eq } from "drizzle-orm";
import { linkedClients } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { authenticateLinkedClient } from "../../../../src/lib/backend-auth";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { createEncryptedSecretToken } from "../../../../src/lib/secrets";
import { reportError } from "../../../../src/lib/log";

export const runtime = "nodejs";

const rotationGraceWindowSeconds = 5 * 60;

export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "backend:rotate-token", {
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

  const linkedClient = await authenticateLinkedClient(
    db,
    request.headers.get("authorization"),
  );
  if (!linkedClient) {
    return jsonError("invalid_link_token", 401);
  }

  let credential: ReturnType<typeof createEncryptedSecretToken>;
  try {
    credential = createEncryptedSecretToken("fc_link");
  } catch (error) {
    reportError("backends.encryption_unavailable", error);
    return jsonError("encryption_not_configured", 503);
  }

  // Keep the outgoing token valid for a short grace window so a backend that
  // never receives this response can retry with its old token instead of
  // being permanently locked out. First use of the new token retires it early
  // (see authenticateLinkedClient).
  await db
    .update(linkedClients)
    .set({
      // The rotated token is returned in this response and nothing can hand it
      // out again (the device code was redeemed long ago), so keep no
      // decryptable copy — see the same reasoning in device/poll.
      encryptedRefreshToken: null,
      lastTokenRotationAt: new Date(),
      previousTokenExpiresAt: new Date(
        Date.now() + rotationGraceWindowSeconds * 1000,
      ),
      previousTokenReference: linkedClient.tokenReference,
      tokenReference: credential.tokenReference,
      updatedAt: new Date(),
    })
    .where(eq(linkedClients.id, linkedClient.id));

  await recordAuditEvent(db, {
    accountId: linkedClient.accountId,
    actor: { linkedClientId: linkedClient.id },
    eventType: "linked_client.token_rotated",
    target: { linkedClientId: linkedClient.id },
  });

  return NextResponse.json({
    access_token: credential.token,
    linked_client_id: linkedClient.id,
    token_reference: credential.tokenReference,
    token_type: "Bearer",
  });
}
