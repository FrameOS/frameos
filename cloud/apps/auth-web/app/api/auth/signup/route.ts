import {
  createDb,
  createPasswordAccount,
  findAccountByPasswordEmail,
  findVerifiedGoogleAccountByEmail,
  normalizeEmail,
  passwordProviderIssuer,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../src/lib/csrf";
import { beginEmailVerification } from "../../../../src/lib/email-verification";
import { assertDatabaseUrlConfigured } from "../../../../src/lib/env";
import {
  hashPassword,
  validatePasswordCandidate,
} from "../../../../src/lib/passwords";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { notifyNewCloudUser } from "../../../../src/lib/signup-notifications";

// Deliberately loose: real validation happens when the address receives the
// password reset email. This only rejects obvious garbage.
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = await rateLimitResponse(request, "auth:signup", {
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => undefined)) as
    | { email?: unknown; name?: unknown; password?: unknown }
    | undefined;
  const email =
    typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const name =
    typeof body?.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 120)
      : undefined;

  if (!email || email.length > 254 || !emailShape.test(email) || !password) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const passwordProblem = validatePasswordCandidate(password);
  if (passwordProblem) {
    return NextResponse.json(
      { error: "weak_password", message: passwordProblem },
      { status: 400 },
    );
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  if (await findAccountByPasswordEmail(db, email)) {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  // A Google-first account with this email: never let a signup plant a
  // password on it (the "verify" email could trick the real owner into
  // activating a stranger's password). The owner adds a password through the
  // reset flow instead, where only the inbox owner picks the password.
  if (await findVerifiedGoogleAccountByEmail(db, email)) {
    return NextResponse.json({ error: "email_taken_google" }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  let account;
  try {
    account = await createPasswordAccount(db, {
      displayName: name,
      email,
      passwordHash,
    });
  } catch {
    // The unique identity index rejects a concurrent signup for this email.
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  await recordAuditEvent(db, {
    accountId: account.accountId,
    actor: { accountId: account.accountId, providerSubject: email },
    eventType: "account.signed_up",
    metadata: { method: "password" },
    target: { providerIssuer: passwordProviderIssuer },
  });

  // Fire-and-forget: createPasswordAccount above only ever inserts a new
  // account (duplicates 409 out earlier), so this is always a fresh signup.
  // notifyNewCloudUser never throws and no-ops without its env vars.
  void notifyNewCloudUser({
    accountId: account.accountId,
    displayName: name,
    email,
    provider: "password",
  });

  await beginEmailVerification(db, account.accountId, email);

  // No session yet: the account only becomes usable after the emailed
  // verification link is clicked, then the user signs in normally.
  return NextResponse.json({ ok: true, verify_email: true });
}
