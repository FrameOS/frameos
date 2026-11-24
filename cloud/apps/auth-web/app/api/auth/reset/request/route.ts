import {
  createDb,
  findAccountByPasswordEmail,
  findVerifiedSocialAccountByEmail,
  normalizeEmail,
} from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../src/lib/env";
import { startPasswordResetMail } from "../../../../../src/lib/password-reset-request";
import {
  clientKey,
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../src/lib/rate-limit";
import { verifyTurnstileToken } from "../../../../../src/lib/turnstile";

// Same loose shape the signup route uses: only obvious garbage is refused,
// the address proves itself by receiving the mail.
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = await rateLimitResponse(request, "auth:reset-request", {
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => undefined)) as
    | { email?: unknown; turnstile_token?: unknown }
    | undefined;
  const email =
    typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  // Shape only, and before the Turnstile token is spent: a mistyped address
  // is refused without costing the single-use token the resubmit needs.
  if (!email || email.length > 254 || !emailShape.test(email)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Reset is the other endpoint that turns an unauthenticated request into an
  // outbound email, so it gets the same gate as signup — otherwise it becomes
  // the cheap way to burn the sending reputation instead.
  const turnstile = await verifyTurnstileToken(
    typeof body?.turnstile_token === "string" ? body.turnstile_token : undefined,
    clientKey(request),
  );
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: "turnstile_failed", turnstile_errors: turnstile.errorCodes },
      { status: 400 },
    );
  }

  const emailLimited = await identityRateLimitResponse(
    email,
    "auth:reset-request-email",
    { limit: 5, windowMs: 60 * 60 * 1000 },
  );
  if (emailLimited) {
    return emailLimited;
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  // The reset flow also serves Google- and Apple-first accounts adding their
  // first password: completing it creates a verified password identity.
  const passwordAccount = await findAccountByPasswordEmail(db, email);
  const accountId =
    passwordAccount?.id ??
    (await findVerifiedSocialAccountByEmail(db, email))?.accountId;

  // Whether or not the email resolves to an account, respond identically and
  // in the same time, so the endpoint cannot be used to enumerate registered
  // addresses: the token, the mail and the audit row happen after the answer
  // (password-reset-request.ts).
  if (accountId) {
    startPasswordResetMail(db, { accountId, email });
  }

  return NextResponse.json({ ok: true });
}
