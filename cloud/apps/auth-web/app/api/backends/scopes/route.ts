import { eq } from "drizzle-orm";
import {
  deviceAuthorizationRequests,
  linkedClients,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import {
  authenticateLinkedClient,
  linkedClientScopes,
} from "../../../../src/lib/backend-auth";
import {
  deviceVerificationUrls,
  generateUniqueUserCode,
  jsonError,
  maskUserCode,
  parseScopes,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { autoGrantedDeviceScopes } from "../../../../src/lib/device-scopes";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { createSecretToken, hashSecret, hashUserCode } from "../../../../src/lib/secrets";

export const runtime = "nodejs";

const expiresInSeconds = 10 * 60;
const intervalSeconds = 5;

// Change a linked client's granted scopes ("enabled features") in place, so a
// backend never has to disconnect and relink. Removing scopes applies
// immediately (the token holder reducing its own privileges needs no consent),
// and so does adding scopes that come with every cloud account (see
// autoGrantedDeviceScopes). Adding a security-sensitive scope creates a device
// authorization request bound to this client; the owner approves it on the
// usual /device screen, and approval rewrites the granted scopes while the
// link token stays the same.
export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "backend:scopes", {
    limit: 60,
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

  const body = await readJsonObject(request);
  if (!Array.isArray(body.scopes)) {
    return jsonError("invalid_scopes", 400);
  }
  const currentScopes = linkedClientScopes(linkedClient);
  let requestedScopes = parseScopes(body.scopes);
  // The base link scope is not a feature; it can never be dropped this way.
  const baseScopes =
    linkedClient.clientKind === "frame"
      ? ["frame:link"]
      : ["backend:link", "backend:read"];
  for (const base of baseScopes) {
    if (currentScopes.includes(base) && !requestedScopes.includes(base)) {
      requestedScopes = [base, ...requestedScopes];
    }
  }

  const added = requestedScopes.filter(
    (scope) => !currentScopes.includes(scope),
  );
  const addedNeedingApproval = added.filter(
    (scope) => !autoGrantedDeviceScopes.has(scope),
  );

  if (addedNeedingApproval.length === 0) {
    const metadata =
      linkedClient.providerClientMetadata &&
      typeof linkedClient.providerClientMetadata === "object" &&
      !Array.isArray(linkedClient.providerClientMetadata)
        ? (linkedClient.providerClientMetadata as Record<string, unknown>)
        : {};
    await db
      .update(linkedClients)
      .set({
        providerClientMetadata: { ...metadata, requestedScopes },
        updatedAt: new Date(),
      })
      .where(eq(linkedClients.id, linkedClient.id));

    await recordAuditEvent(db, {
      accountId: linkedClient.accountId,
      actor: { linkedClientId: linkedClient.id },
      eventType:
        added.length === 0
          ? "linked_client.scopes_reduced"
          : "linked_client.scopes_updated",
      metadata: { scopes: requestedScopes },
      target: { linkedClientId: linkedClient.id },
    });

    return NextResponse.json({
      linked_client_id: linkedClient.id,
      scope: requestedScopes.join(" "),
      status: "updated",
    });
  }

  // Security-sensitive additions need the owner's consent on the approval
  // screen. The request carries the full desired scope set, so any included
  // features being added ride along with the same approval.
  const userCode = await generateUniqueUserCode(db);
  const deviceCode = createSecretToken("fc_device", 40);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  await db.insert(deviceAuthorizationRequests).values({
    clientKind: linkedClient.clientKind,
    deviceCodeHash: hashSecret(deviceCode),
    expiresAt,
    intervalSeconds,
    localOrigin: linkedClient.localOrigin,
    publicDisplayName: linkedClient.publicDisplayName,
    requestedScopes,
    upgradeLinkedClientId: linkedClient.id,
    userCodeDisplay: maskUserCode(userCode),
    userCodeHash: hashUserCode(userCode.replace("-", "")),
  });

  return NextResponse.json({
    device_code: deviceCode,
    expires_in: expiresInSeconds,
    interval: intervalSeconds,
    scope: requestedScopes.join(" "),
    status: "approval_required",
    user_code: userCode,
    ...deviceVerificationUrls(userCode),
  });
}
