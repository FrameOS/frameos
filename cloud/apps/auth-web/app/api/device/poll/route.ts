import { and, eq, isNull } from "drizzle-orm";
import { deviceAuthorizationRequests, linkedClients } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { decryptSecret, hashSecret } from "../../../../src/lib/secrets";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const limited = rateLimitResponse(request, "device:poll", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const body = await readJsonObject(request);
  const deviceCode =
    typeof body.device_code === "string" ? body.device_code : "";
  if (!deviceCode) {
    return jsonError("invalid_device_code", 400);
  }

  const [deviceRequest] = await db
    .select()
    .from(deviceAuthorizationRequests)
    .where(
      eq(deviceAuthorizationRequests.deviceCodeHash, hashSecret(deviceCode)),
    )
    .limit(1);

  if (!deviceRequest) {
    return jsonError("invalid_device_code", 400);
  }

  if (
    deviceRequest.status === "pending" &&
    deviceRequest.expiresAt <= new Date()
  ) {
    await db
      .update(deviceAuthorizationRequests)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(deviceAuthorizationRequests.id, deviceRequest.id));
    return jsonError("expired_token", 400);
  }

  if (deviceRequest.status === "pending") {
    await db
      .update(deviceAuthorizationRequests)
      .set({
        lastPollAt: new Date(),
        pollCount: deviceRequest.pollCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(deviceAuthorizationRequests.id, deviceRequest.id));
    return NextResponse.json(
      {
        error: "authorization_pending",
        interval: deviceRequest.intervalSeconds,
      },
      { status: 428 },
    );
  }

  if (deviceRequest.status === "denied") {
    return jsonError("access_denied", 403);
  }

  if (deviceRequest.status === "expired") {
    return jsonError("expired_token", 400);
  }

  // Approved scope changes carry no token: the linked client keeps its
  // credential, only the granted scopes changed. Still single-use.
  if (deviceRequest.upgradeLinkedClientId) {
    const [claimedUpgrade] = await db
      .update(deviceAuthorizationRequests)
      .set({ redeemedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(deviceAuthorizationRequests.id, deviceRequest.id),
          isNull(deviceAuthorizationRequests.redeemedAt),
        ),
      )
      .returning({ id: deviceAuthorizationRequests.id });
    if (!claimedUpgrade) {
      return jsonError("expired_token", 400);
    }
    return NextResponse.json({
      linked_client_id: deviceRequest.upgradeLinkedClientId,
      scope: deviceRequest.requestedScopes.join(" "),
      status: "approved",
    });
  }

  if (!deviceRequest.linkedClientId || !deviceRequest.tokenReference) {
    return jsonError("invalid_device_code", 400);
  }

  // RFC 8628: the device_code is single-use. Atomically claim the redemption so
  // a leaked or replayed device_code cannot keep fetching the (possibly rotated)
  // link token after the backend has already read it once.
  const [claimed] = await db
    .update(deviceAuthorizationRequests)
    .set({ redeemedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(deviceAuthorizationRequests.id, deviceRequest.id),
        isNull(deviceAuthorizationRequests.redeemedAt),
      ),
    )
    .returning({ id: deviceAuthorizationRequests.id });

  if (!claimed) {
    return jsonError("expired_token", 400);
  }

  const [linkedClient] = await db
    .select()
    .from(linkedClients)
    .where(
      and(
        eq(linkedClients.id, deviceRequest.linkedClientId),
        isNull(linkedClients.revokedAt),
      ),
    )
    .limit(1);

  if (!linkedClient?.encryptedRefreshToken) {
    return jsonError("invalid_device_code", 400);
  }

  await db
    .update(linkedClients)
    .set({ lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(linkedClients.id, linkedClient.id));

  return NextResponse.json({
    access_token: decryptSecret(linkedClient.encryptedRefreshToken),
    // Who approved the link, in login-handoff claim format, so FrameOS can
    // map its local user to this cloud account right away. Single-use, like
    // the token: the redemption claim above guards both.
    approved_by: approvedByClaims(linkedClient.providerClientMetadata),
    linked_client_id: linkedClient.id,
    scope: deviceRequest.requestedScopes.join(" "),
    token_reference: deviceRequest.tokenReference,
    token_type: "Bearer",
  });
}

function approvedByClaims(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const approvedBy = (metadata as Record<string, unknown>).approvedBy;
  if (!approvedBy || typeof approvedBy !== "object" || Array.isArray(approvedBy)) {
    return null;
  }
  const record = approvedBy as Record<string, unknown>;
  if (
    typeof record.providerIssuer !== "string" ||
    typeof record.providerSubject !== "string"
  ) {
    return null;
  }
  return {
    account_id: typeof record.accountId === "string" ? record.accountId : null,
    email: typeof record.email === "string" ? record.email : null,
    email_verified: record.emailVerified === true,
    name: typeof record.name === "string" ? record.name : null,
    provider_issuer: record.providerIssuer,
    provider_subject: record.providerSubject,
    sub: record.providerSubject,
  };
}
