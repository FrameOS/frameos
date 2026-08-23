// Passwordless sign-in, step 2: the assertion names the credential, the
// credential names the account. A verified (PIN/biometric) passkey counts as
// both factors, so no second step follows.
import { eq } from "drizzle-orm";
import {
  accountIdentities,
  accounts,
  createDb,
  passwordProviderIssuer,
} from "@frameos-cloud/db";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { safeAuthReturnPath } from "../../../../../src/lib/auth-cookies";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import {
  createSession,
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../../src/lib/session";
import {
  readChallengeToken,
  verifyPasskeyAssertion,
  webauthnChallengeCookieName,
  webauthnChallengeCookieOptions,
} from "../../../../../src/lib/webauthn";
import { defaultSignInRedirect } from "../../../../../src/lib/sign-in-redirect";

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
  const challenge = await readChallengeToken(
    request.cookies.get(webauthnChallengeCookieName)?.value,
    "authenticate",
  );
  if (!challenge) {
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
    { requireUserVerification: true },
  );
  if (!result) {
    return NextResponse.json({ error: "invalid_passkey" }, { status: 401 });
  }

  const [account] = await db
    .select({
      displayName: accounts.displayName,
      id: accounts.id,
      primaryEmail: accounts.primaryEmail,
    })
    .from(accounts)
    .where(eq(accounts.id, result.accountId))
    .limit(1);
  if (!account) {
    return NextResponse.json({ error: "invalid_passkey" }, { status: 401 });
  }
  // Prefer the verified password identity's email as the subject, the way
  // the password route does; fall back to the snapshot.
  const [identity] = await db
    .select({
      emailSnapshot: accountIdentities.emailSnapshot,
      emailVerified: accountIdentities.emailVerified,
      providerSubject: accountIdentities.providerSubject,
    })
    .from(accountIdentities)
    .where(eq(accountIdentities.accountId, account.id))
    .limit(1);
  const email =
    identity?.emailSnapshot ?? account.primaryEmail ?? undefined;

  await recordAuditEvent(db, {
    accountId: account.id,
    actor: { accountId: account.id, providerSubject: email },
    eventType: "account.signed_in",
    metadata: { method: "passkey", passkey: result.passkeyName },
    target: { providerIssuer: passwordProviderIssuer },
  });
  const token = await createSession(db, {
    accountId: account.id,
    email,
    emailVerified: identity?.emailVerified ?? true,
    name: account.displayName ?? undefined,
    providerIssuer: passwordProviderIssuer,
    providerSubject: identity?.providerSubject ?? account.id,
  });

  const returnTo =
    typeof body.return_to === "string"
      ? safeAuthReturnPath(body.return_to)
      : undefined;
  const response = NextResponse.json({
    ok: true,
    redirect: returnTo ?? defaultSignInRedirect,
  });
  response.cookies.set(sessionCookieName, token, sessionCookieOptions());
  response.cookies.set(webauthnChallengeCookieName, "", {
    ...webauthnChallengeCookieOptions(),
    maxAge: 0,
  });
  return response;
}
