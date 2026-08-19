// Second step of sign-in with a passkey: assertion options restricted to the
// pending account's credentials. The challenge travels in a signed cookie.
import { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { pendingSignInFromRequest } from "../../../../../../src/lib/sign-in";
import {
  createChallengeToken,
  passkeySecondFactorOptions,
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
  if (!pending) {
    return NextResponse.json({ error: "sign_in_expired" }, { status: 401 });
  }
  assertDatabaseUrlConfigured();
  const options = await passkeySecondFactorOptions(
    createDb(),
    pending.profile.accountId,
  );
  const response = NextResponse.json({ options });
  response.cookies.set(
    webauthnChallengeCookieName,
    await createChallengeToken({
      accountId: pending.profile.accountId,
      challenge: options.challenge,
      purpose: "second_factor",
    }),
    webauthnChallengeCookieOptions(),
  );
  return response;
}
