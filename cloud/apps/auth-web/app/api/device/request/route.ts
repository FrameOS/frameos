import { eq } from "drizzle-orm";
import { deviceAuthorizationRequests } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  formatUserCode,
  jsonError,
  normalizeUserCode,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { hashUserCode } from "../../../../src/lib/secrets";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "device:request", {
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

  // Looking up a pending request requires a signed-in session: codes and the
  // requests behind them are not public, and the approval screen sits behind
  // login anyway.
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }

  const userCode = normalizeUserCode(
    request.nextUrl.searchParams.get("user_code") ?? "",
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

  let status = deviceRequest.status;
  if (status === "pending" && deviceRequest.expiresAt <= new Date()) {
    status = "expired";
    await db
      .update(deviceAuthorizationRequests)
      .set({ status, updatedAt: new Date() })
      .where(eq(deviceAuthorizationRequests.id, deviceRequest.id));
  }

  return NextResponse.json({
    client_kind: deviceRequest.clientKind,
    expires_at: deviceRequest.expiresAt.toISOString(),
    local_origin: deviceRequest.localOrigin,
    public_display_name: deviceRequest.publicDisplayName,
    requested_scopes: deviceRequest.requestedScopes,
    // True when this request changes an existing link's enabled features
    // instead of connecting a new device.
    scope_change: Boolean(deviceRequest.upgradeLinkedClientId),
    signed_in: true,
    status,
    // Echo the caller's own code back in display form; the stored copy is
    // masked and must never leave the database in full.
    user_code: formatUserCode(userCode),
  });
}
