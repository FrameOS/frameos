// Second step of sign-in with a passkey: verify the assertion against the
// pending account and mint the session.
import { createDb } from "@frameos-cloud/db";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../../src/lib/env";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../../src/lib/rate-limit";
import {
  completeSecondFactor,
  pendingSignInFromRequest,
  pendingSignInSpent,
  signedInResponse,
} from "../../../../../../src/lib/sign-in";
import {
  readChallengeToken,
  verifyPasskeyAssertion,
  webauthnChallengeCookieName,
  webauthnChallengeCookieOptions,
} from "../../../../../../src/lib/webauthn";

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "auth:second-factor", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const pending = await pendingSignInFromRequest(request);
  if (!pending || (await pendingSignInSpent(pending))) {
    return NextResponse.json({ error: "sign_in_expired" }, { status: 401 });
  }
  const accountId = pending.profile.accountId;
  const accountLimited = await identityRateLimitResponse(
    accountId,
    "auth:second-factor-account",
    { limit: 10, windowMs: 15 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }
  const challenge = await readChallengeToken(
    request.cookies.get(webauthnChallengeCookieName)?.value,
    "second_factor",
  );
  if (!challenge || challenge.accountId !== accountId) {
    return NextResponse.json({ error: "challenge_expired" }, { status: 400 });
  }
  const body = (await request.json().catch(() => undefined)) as
    | { response?: AuthenticationResponseJSON }
    | undefined;
  if (!body?.response || typeof body.response !== "object") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  const result = await verifyPasskeyAssertion(
    db,
    body.response,
    challenge.challenge,
    { accountId, requireUserVerification: false },
  );
  if (!result) {
    await recordAuditEvent(db, {
      accountId,
      actor: { accountId, providerSubject: pending.profile.providerSubject },
      eventType: "account.second_factor_failed",
      metadata: { method: "passkey" },
    });
    return NextResponse.json({ error: "invalid_passkey" }, { status: 401 });
  }

  const token = await completeSecondFactor(db, pending, "passkey", {
    passkey: result.passkeyName,
  });
  if (!token) {
    return NextResponse.json({ error: "sign_in_expired" }, { status: 401 });
  }
  const response = signedInResponse(token, pending.returnTo);
  response.cookies.set(webauthnChallengeCookieName, "", {
    ...webauthnChallengeCookieOptions(),
    maxAge: 0,
  });
  return response;
}
