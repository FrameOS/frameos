// Re-authentication with a passkey, step two: verify the assertion against
// the signed-in account and stamp the session.
import { createDb } from "@frameos-cloud/db";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { NextRequest, NextResponse } from "next/server";
import { assertDatabaseUrlConfigured } from "../../../../../../src/lib/env";
import {
  reauthContext,
  reauthenticatedResponse,
  recordReauthFailed,
} from "../../../../../../src/lib/reauth";
import {
  readChallengeToken,
  verifyPasskeyAssertion,
  webauthnChallengeCookieName,
  webauthnChallengeCookieOptions,
} from "../../../../../../src/lib/webauthn";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const context = await reauthContext(request);
  if ("response" in context) {
    return context.response;
  }
  const challenge = await readChallengeToken(
    request.cookies.get(webauthnChallengeCookieName)?.value,
    "reauth",
  );
  if (!challenge || challenge.accountId !== context.accountId) {
    return NextResponse.json({ error: "challenge_expired" }, { status: 400 });
  }
  const body = (await request.json().catch(() => undefined)) as
    | { response?: AuthenticationResponseJSON; return_to?: unknown }
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
    { accountId: context.accountId, requireUserVerification: false },
  );
  if (!result) {
    await recordReauthFailed(db, context, "passkey");
    return NextResponse.json({ error: "invalid_passkey" }, { status: 403 });
  }
  const response = await reauthenticatedResponse(
    db,
    context,
    "passkey",
    body.return_to,
    { passkey: result.passkeyName },
  );
  response.cookies.set(webauthnChallengeCookieName, "", {
    ...webauthnChallengeCookieOptions(),
    maxAge: 0,
  });
  return response;
}
