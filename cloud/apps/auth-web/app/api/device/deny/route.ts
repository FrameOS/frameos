import { and, eq } from "drizzle-orm";
import {
  consentEvents,
  deviceAuthorizationRequests,
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
import { hashUserCode } from "../../../../src/lib/secrets";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = rateLimitResponse(request, "device:deny", {
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

  // Cap user-code guessing per account (IP limits are spoofable behind proxies).
  const accountLimited = identityRateLimitResponse(
    session.accountId,
    "device:deny",
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
  const userCode = normalizeUserCode(typeof body.user_code === "string" ? body.user_code : "");
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

  // Atomic claim: only one decision can win a pending request.
  const [denied] = await db
    .update(deviceAuthorizationRequests)
    .set({
      approvedByAccountId: session.accountId,
      deniedAt: new Date(),
      status: "denied",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deviceAuthorizationRequests.id, deviceRequest.id),
        eq(deviceAuthorizationRequests.status, "pending"),
      ),
    )
    .returning({ id: deviceAuthorizationRequests.id });

  if (!denied) {
    return jsonError("device_request_conflict", 409);
  }

  await db.insert(consentEvents).values({
    accountId: session.accountId,
    decision: "denied",
    ipAddress: clientKey(request),
    scopes: deviceRequest.requestedScopes,
    userAgent: request.headers.get("user-agent"),
  });

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: { accountId: session.accountId, providerSubject: session.providerSubject },
    eventType: "device_authorization.denied",
    metadata: { scopes: deviceRequest.requestedScopes },
    target: { userCode: deviceRequest.userCodeDisplay },
  });

  return NextResponse.json({ status: "denied" });
}
