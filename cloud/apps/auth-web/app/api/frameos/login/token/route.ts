import { and, eq, isNull } from "drizzle-orm";
import {
  accountIdentities,
  accounts,
  frameosLoginCodes,
} from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  authenticateLinkedClient,
  linkedClientHasScope,
} from "../../../../../src/lib/backend-auth";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { hashSecret } from "../../../../../src/lib/secrets";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "frameos-login:token", {
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

  const linkedClient = await authenticateLinkedClient(
    db,
    request.headers.get("authorization"),
  );
  if (!linkedClient) {
    return jsonError("invalid_link_token", 401);
  }

  // Checked at /start too, but a code minted minutes ago must not still be
  // redeemable after the owner turns cloud login off.
  if (!linkedClientHasScope(linkedClient, "auth:login")) {
    return jsonError("insufficient_scope", 403);
  }

  const body = await readJsonObject(request);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return jsonError("invalid_code", 400);
  }

  // Atomically claim the code: bound to this linked client, unredeemed, and
  // unexpired. A replayed or stolen code fails here.
  const [redeemed] = await db
    .update(frameosLoginCodes)
    .set({ redeemedAt: new Date() })
    .where(
      and(
        eq(frameosLoginCodes.codeHash, hashSecret(code)),
        eq(frameosLoginCodes.linkedClientId, linkedClient.id),
        isNull(frameosLoginCodes.redeemedAt),
      ),
    )
    .returning({
      accountId: frameosLoginCodes.accountId,
      expiresAt: frameosLoginCodes.expiresAt,
      identityId: frameosLoginCodes.identityId,
    });

  if (!redeemed || redeemed.expiresAt <= new Date() || !redeemed.identityId) {
    return jsonError("invalid_code", 400);
  }

  // Resolve the profile at redemption instead of releasing a snapshot taken
  // at authorization time: the account or identity may have changed (or been
  // deleted) in between, and the row itself stores no PII.
  const [resolved] = await db
    .select({
      displayName: accounts.displayName,
      emailSnapshot: accountIdentities.emailSnapshot,
      emailVerified: accountIdentities.emailVerified,
      primaryEmail: accounts.primaryEmail,
      providerIssuer: accountIdentities.providerIssuer,
      providerSubject: accountIdentities.providerSubject,
    })
    .from(accountIdentities)
    .innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(
      and(
        eq(accountIdentities.id, redeemed.identityId),
        eq(accountIdentities.accountId, redeemed.accountId),
      ),
    )
    .limit(1);
  if (!resolved) {
    return jsonError("invalid_code", 400);
  }

  return NextResponse.json({
    claims: {
      account_id: redeemed.accountId,
      email: resolved.emailSnapshot ?? resolved.primaryEmail ?? undefined,
      email_verified: resolved.emailVerified,
      name: resolved.displayName ?? undefined,
      provider_subject: resolved.providerSubject,
      sub: resolved.providerSubject,
    },
    provider_issuer: resolved.providerIssuer,
  });
}
