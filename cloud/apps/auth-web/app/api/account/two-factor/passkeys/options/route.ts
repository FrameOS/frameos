// Passkey registration, step 1: creation options for the signed-in account.
// Needs the password when the account has one (requireStrengtheningProof);
// step 2 is bound to the challenge cookie minted here, so the proof is
// checked once, at this step.
import { NextRequest, NextResponse } from "next/server";
import {
  accountSecurityContext,
  readJsonBody,
  requireStrengtheningProof,
} from "../../../../../../src/lib/account-security";
import { requireDatabase } from "../../../../../../src/lib/device-flow";
import {
  createChallengeToken,
  listAccountPasskeys,
  maxPasskeysPerAccount,
  passkeyRegistrationOptions,
  webauthnChallengeCookieName,
  webauthnChallengeCookieOptions,
} from "../../../../../../src/lib/webauthn";

export async function POST(request: NextRequest) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const context = await accountSecurityContext(request, db, {
    action: "two-factor-passkeys",
    mutating: true,
    recentAuth: true,
  });
  if ("response" in context) {
    return context.response;
  }
  const denied = await requireStrengtheningProof(
    db,
    context,
    await readJsonBody(request),
  );
  if (denied) {
    return denied;
  }
  const existing = await listAccountPasskeys(db, context.accountId);
  if (existing.length >= maxPasskeysPerAccount) {
    return NextResponse.json({ error: "too_many_passkeys" }, { status: 409 });
  }
  const options = await passkeyRegistrationOptions(db, {
    email: context.email,
    id: context.accountId,
    name: context.displayName,
  });
  const result = NextResponse.json({ options });
  result.cookies.set(
    webauthnChallengeCookieName,
    await createChallengeToken({
      accountId: context.accountId,
      challenge: options.challenge,
      purpose: "register",
    }),
    webauthnChallengeCookieOptions(),
  );
  return result;
}
