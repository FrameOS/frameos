import {
  createDb,
  findAccountByPasswordEmail,
  normalizeEmail,
  passwordProviderIssuer,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { safeAuthReturnPath } from "../../../../src/lib/auth-cookies";
import { csrfResponse } from "../../../../src/lib/csrf";
import { beginEmailVerification } from "../../../../src/lib/email-verification";
import { assertDatabaseUrlConfigured } from "../../../../src/lib/env";
import { verifyPasswordWithDummyFallback } from "../../../../src/lib/passwords";
import {
  checkRateLimit,
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import {
  createSession,
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../src/lib/session";

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = await rateLimitResponse(request, "auth:login", {
    limit: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => undefined)) as
    | { email?: unknown; password?: unknown; return_to?: unknown }
    | undefined;
  const email =
    typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // A second limit keyed on the target email caps distributed brute force
  // against one account across many source IPs.
  const emailLimited = await identityRateLimitResponse(email, "auth:login-email", {
    limit: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (emailLimited) {
    return emailLimited;
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  const account = await findAccountByPasswordEmail(db, email);
  const passwordValid = await verifyPasswordWithDummyFallback(
    password,
    account?.passwordHash,
  );
  if (!account || !passwordValid) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  // Correct password but unverified email: no session. Resend the
  // verification link (throttled) since the correct password proves this is
  // the account owner, then tell them to check their inbox.
  if (!account.emailVerified) {
    const resend = await checkRateLimit(`auth:verify-email-resend:${account.id}`, {
      limit: 3,
      windowMs: 60 * 60 * 1000,
    });
    if (resend.allowed) {
      await beginEmailVerification(db, account.id, email);
    }
    return NextResponse.json({ error: "email_unverified" }, { status: 403 });
  }

  await recordAuditEvent(db, {
    accountId: account.id,
    actor: { accountId: account.id, providerSubject: email },
    eventType: "account.signed_in",
    metadata: { method: "password" },
    target: { providerIssuer: passwordProviderIssuer },
  });

  const sessionToken = await createSession(db, {
    accountId: account.id,
    email: account.primaryEmail ?? email,
    emailVerified: account.emailVerified,
    name: account.displayName ?? undefined,
    providerIssuer: passwordProviderIssuer,
    providerSubject: email,
  });

  const returnTo =
    typeof body?.return_to === "string"
      ? safeAuthReturnPath(body.return_to)
      : undefined;
  const response = NextResponse.json({
    ok: true,
    redirect: returnTo ?? "/account",
  });
  response.cookies.set(sessionCookieName, sessionToken, sessionCookieOptions());
  return response;
}
