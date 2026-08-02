import { and, eq, gt } from "drizzle-orm";
import {
  connectedBackends,
  consentEvents,
  deviceAuthorizationRequests,
  linkedClients,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  normalizeUserCode,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import {
  clientKey,
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import { createEncryptedSecretToken, hashUserCode } from "../../../../src/lib/secrets";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = rateLimitResponse(request, "device:authorize", {
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
  const accountId = session.accountId;

  // Cap user-code guessing per account (IP limits are spoofable behind proxies).
  const accountLimited = identityRateLimitResponse(
    accountId,
    "device:authorize",
    { limit: 30, windowMs: 15 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const body = await readJsonObject(request);
  const userCode = normalizeUserCode(
    typeof body.user_code === "string" ? body.user_code : "",
  );
  if (userCode.length !== 8) {
    return jsonError("invalid_user_code", 400);
  }

  const [deviceRequest] = await db
    .select()
    .from(deviceAuthorizationRequests)
    .where(eq(deviceAuthorizationRequests.userCodeHash, hashUserCode(userCode)))
    .limit(1);

  if (!deviceRequest) {
    return jsonError("invalid_user_code", 404);
  }

  if (deviceRequest.status !== "pending") {
    return jsonError(`device_request_${deviceRequest.status}`, 409);
  }

  if (deviceRequest.expiresAt <= new Date()) {
    await db
      .update(deviceAuthorizationRequests)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(deviceAuthorizationRequests.id, deviceRequest.id));
    return jsonError("expired_token", 400);
  }

  // Scope-change requests rewrite an existing linked client's granted scopes
  // in place; only the account that owns that client may approve them, and no
  // new credential is minted.
  if (deviceRequest.upgradeLinkedClientId) {
    const [targetClient] = await db
      .select()
      .from(linkedClients)
      .where(eq(linkedClients.id, deviceRequest.upgradeLinkedClientId))
      .limit(1);
    if (
      !targetClient ||
      targetClient.accountId !== accountId ||
      targetClient.revokedAt
    ) {
      return jsonError("linked_client_required", 403);
    }

    const claimed = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(deviceAuthorizationRequests)
        .set({
          approvedAt: new Date(),
          approvedByAccountId: accountId,
          linkedClientId: targetClient.id,
          status: "approved",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deviceAuthorizationRequests.id, deviceRequest.id),
            eq(deviceAuthorizationRequests.status, "pending"),
            gt(deviceAuthorizationRequests.expiresAt, new Date()),
          ),
        )
        .returning({ id: deviceAuthorizationRequests.id });
      if (!row) {
        return false;
      }

      const metadata = metadataRecord(targetClient.providerClientMetadata);
      await tx
        .update(linkedClients)
        .set({
          providerClientMetadata: {
            ...metadata,
            requestedScopes: deviceRequest.requestedScopes,
          },
          updatedAt: new Date(),
        })
        .where(eq(linkedClients.id, targetClient.id));
      return true;
    });

    if (!claimed) {
      return jsonError("device_request_conflict", 409);
    }

    await db.insert(consentEvents).values({
      accountId,
      decision: "approved",
      ipAddress: clientKey(request),
      linkedClientId: targetClient.id,
      scopes: deviceRequest.requestedScopes,
      userAgent: request.headers.get("user-agent"),
    });
    await recordAuditEvent(db, {
      accountId,
      actor: { accountId, providerSubject: session.providerSubject },
      eventType: "linked_client.scopes_updated",
      metadata: { scopes: deviceRequest.requestedScopes },
      target: {
        linkedClientId: targetClient.id,
        userCode: deviceRequest.userCodeDisplay,
      },
    });

    return NextResponse.json({
      linked_client_id: targetClient.id,
      status: "approved",
    });
  }

  let credential: ReturnType<typeof createEncryptedSecretToken>;

  try {
    credential = createEncryptedSecretToken("fc_link");
  } catch (error) {
    console.error(
      "device/authorize: encryption unavailable:",
      error instanceof Error ? error.message : "unknown error",
    );
    return jsonError("encryption_not_configured", 503);
  }

  const metadata = metadataRecord(deviceRequest.backendMetadata);

  // All-or-nothing: atomically claim the pending request first so concurrent
  // approvals cannot each mint a credential, then create the linked client and
  // finish the request in the same transaction so a crash cannot leave a live
  // credential behind a still-pending request.
  const linkedClientId = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(deviceAuthorizationRequests)
      .set({
        approvedAt: new Date(),
        approvedByAccountId: accountId,
        status: "approved",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deviceAuthorizationRequests.id, deviceRequest.id),
          eq(deviceAuthorizationRequests.status, "pending"),
          gt(deviceAuthorizationRequests.expiresAt, new Date()),
        ),
      )
      .returning({ id: deviceAuthorizationRequests.id });

    if (!claimed) {
      return undefined;
    }

    const [linkedClient] = await tx
      .insert(linkedClients)
      .values({
        accountId,
        clientKind: deviceRequest.clientKind,
        encryptedRefreshToken: credential.encryptedToken,
        lastTokenRotationAt: new Date(),
        localOrigin: deviceRequest.localOrigin,
        providerClientMetadata: {
          // Identity snapshot of the approver, released once when the device
          // code is redeemed so FrameOS can map its local user to this cloud
          // account without a second browser handoff.
          approvedBy: {
            accountId,
            email: session.email ?? null,
            emailVerified: session.emailVerified ?? false,
            name: session.name ?? null,
            providerIssuer: session.providerIssuer,
            providerSubject: session.providerSubject,
          },
          deviceAuthorizationRequestId: deviceRequest.id,
          requestedScopes: deviceRequest.requestedScopes,
          ...metadata,
        },
        publicDisplayName: deviceRequest.publicDisplayName,
        tokenReference: credential.tokenReference,
      })
      .returning({ id: linkedClients.id });

    if (!linkedClient) {
      throw new Error("Failed to create linked client");
    }

    await tx.insert(connectedBackends).values({
      capabilities: metadata.capabilities ?? {},
      linkedClientId: linkedClient.id,
      reportedFrameosVersion:
        typeof metadata.reportedFrameosVersion === "string"
          ? metadata.reportedFrameosVersion
          : null,
    });

    await tx
      .update(deviceAuthorizationRequests)
      .set({
        linkedClientId: linkedClient.id,
        tokenReference: credential.tokenReference,
        updatedAt: new Date(),
      })
      .where(eq(deviceAuthorizationRequests.id, deviceRequest.id));

    return linkedClient.id;
  });

  if (!linkedClientId) {
    // Another request claimed (or expired) this code between our check and the
    // transactional claim.
    return jsonError("device_request_conflict", 409);
  }

  await db.insert(consentEvents).values({
    accountId,
    decision: "approved",
    ipAddress: clientKey(request),
    linkedClientId,
    scopes: deviceRequest.requestedScopes,
    userAgent: request.headers.get("user-agent"),
  });

  await recordAuditEvent(db, {
    accountId,
    actor: {
      accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "device_authorization.approved",
    metadata: { scopes: deviceRequest.requestedScopes },
    target: {
      linkedClientId,
      userCode: deviceRequest.userCodeDisplay,
    },
  });

  return NextResponse.json({
    linked_client_id: linkedClientId,
    status: "approved",
  });
}

function metadataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}
