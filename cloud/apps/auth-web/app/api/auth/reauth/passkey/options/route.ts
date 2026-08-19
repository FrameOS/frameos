// Re-authentication with a passkey, step one: assertion options restricted
// to the signed-in account's credentials. The challenge travels in a signed
// cookie, as for the second-factor step.
import { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { assertDatabaseUrlConfigured } from "../../../../../../src/lib/env";
import { reauthContext } from "../../../../../../src/lib/reauth";
import {
  createChallengeToken,
  passkeySecondFactorOptions,
  webauthnChallengeCookieName,
  webauthnChallengeCookieOptions,
} from "../../../../../../src/lib/webauthn";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const context = await reauthContext(request);
  if ("response" in context) {
    return context.response;
  }
  assertDatabaseUrlConfigured();
  const options = await passkeySecondFactorOptions(createDb(), context.accountId);
  const response = NextResponse.json({ options });
  response.cookies.set(
    webauthnChallengeCookieName,
    await createChallengeToken({
      accountId: context.accountId,
      challenge: options.challenge,
      purpose: "reauth",
    }),
    webauthnChallengeCookieOptions(),
  );
  return response;
}
