// Passwordless sign-in, step 1: discoverable-credential assertion options.
// No account is named; the authenticator picks one, and verification is
// required because this single step is the whole sign-in.
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import {
  createChallengeToken,
  passkeySignInOptions,
  webauthnChallengeCookieName,
  webauthnChallengeCookieOptions,
} from "../../../../../src/lib/webauthn";

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "auth:passkey", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const options = await passkeySignInOptions();
  const response = NextResponse.json({ options });
  response.cookies.set(
    webauthnChallengeCookieName,
    await createChallengeToken({
      challenge: options.challenge,
      purpose: "authenticate",
    }),
    webauthnChallengeCookieOptions(),
  );
  return response;
}
